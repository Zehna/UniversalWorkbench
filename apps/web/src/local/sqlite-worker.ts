/// <reference lib="webworker" />

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type {
  Artifact,
  DocumentRevision,
  NoteDocument,
  NoteDocumentView,
  Project,
  SyncChange,
  SyncOperation,
} from "@uw/contracts";
import { LOCAL_DATABASE_FILENAME, LOCAL_SCHEMA_SQL } from "./schema";
import type {
  LocalConflictRecord,
  LocalDeviceRecord,
  LocalMutation,
  LocalTombstone,
} from "./store";

type SqlValue = string | number | null;

interface SqliteDatabase {
  exec(
    input:
      | string
      | {
          sql: string;
          bind?: SqlValue[];
          rowMode?: "object";
          returnValue?: "resultRows";
        },
  ): unknown;
  close(): void;
}

type WorkerRequest =
  | { id: number; type: "init" }
  | { id: number; type: "transaction"; mutations: LocalMutation[] }
  | { id: number; type: "getDevice" }
  | { id: number; type: "setDevice"; device: LocalDeviceRecord }
  | { id: number; type: "getCursor" }
  | { id: number; type: "setCursor"; cursor: string }
  | { id: number; type: "listProjects" }
  | { id: number; type: "listNotes"; projectId: string }
  | { id: number; type: "getNote"; documentId: string }
  | { id: number; type: "listPendingOperations"; limit: number }
  | {
      id: number;
      type: "markOperationAcked";
      operationId: string;
      cursor: string;
    }
  | { id: number; type: "applyRemoteChange"; change: SyncChange }
  | { id: number; type: "listConflicts" }
  | { id: number; type: "clearConflict"; operationId: string }
  | { id: number; type: "close" };

interface WorkerResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

let database: SqliteDatabase | null = null;

function db(): SqliteDatabase {
  if (!database) throw new Error("Local SQLite database is not initialized");
  return database;
}

function queryRows<T>(sql: string, bind: SqlValue[] = []): T[] {
  return db().exec({
    sql,
    bind,
    rowMode: "object",
    returnValue: "resultRows",
  }) as T[];
}

function execute(sql: string, bind: SqlValue[] = []): void {
  db().exec({ sql, bind });
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function setMeta(key: string, value: string): void {
  execute(
    `INSERT INTO local_meta (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

function getMeta(key: string): string | null {
  const [row] = queryRows<{ value: string }>(
    "SELECT value FROM local_meta WHERE key = ? LIMIT 1",
    [key],
  );
  return row?.value ?? null;
}

function upsertProject(project: Project): void {
  execute(
    `INSERT INTO projects (
       id, owner_id, name, description, schema_version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       owner_id = excluded.owner_id,
       name = excluded.name,
       description = excluded.description,
       schema_version = excluded.schema_version,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    [
      project.id,
      project.ownerId,
      project.name,
      project.description,
      project.schemaVersion,
      project.createdAt,
      project.updatedAt,
    ],
  );
}

function upsertNote(view: NoteDocumentView): void {
  const { document, revision } = view;
  execute(
    `INSERT INTO document_revisions (
       id, document_id, revision_number, parent_revision_id,
       content_json, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    [
      revision.id,
      revision.documentId,
      revision.revisionNumber,
      revision.parentRevisionId,
      json(revision.content),
      json(revision.metadata),
      revision.createdAt,
    ],
  );
  execute(
    `INSERT INTO documents (
       id, project_id, kind, title, current_revision_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       project_id = excluded.project_id,
       kind = excluded.kind,
       title = excluded.title,
       current_revision_id = excluded.current_revision_id,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    [
      document.id,
      document.projectId,
      document.kind,
      document.title,
      document.currentRevisionId,
      document.createdAt,
      document.updatedAt,
    ],
  );
}

function putTombstone(tombstone: LocalTombstone): void {
  execute(
    `INSERT INTO tombstones (
       entity_type, entity_id, cursor, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(entity_type, entity_id) DO UPDATE SET
       cursor = excluded.cursor,
       payload_json = excluded.payload_json,
       created_at = excluded.created_at`,
    [
      tombstone.entityType,
      tombstone.entityId,
      tombstone.cursor,
      json(tombstone.payload),
      tombstone.createdAt,
    ],
  );
}

function appendOperation(operation: SyncOperation): void {
  execute(
    `INSERT INTO pending_operations (
       operation_id, operation_json, status, ack_cursor, created_at
     ) VALUES (?, ?, 'pending', NULL, ?)
     ON CONFLICT(operation_id) DO NOTHING`,
    [operation.id, json(operation), operation.createdAt],
  );
}

function applyMutation(mutation: LocalMutation): void {
  switch (mutation.type) {
    case "upsertProject":
      upsertProject(mutation.project);
      return;
    case "upsertNote":
      upsertNote(mutation.note);
      return;
    case "putTombstone":
      putTombstone(mutation.tombstone);
      return;
    case "appendOperation":
      appendOperation(mutation.operation);
      return;
  }
}

function listProjects(): Project[] {
  return queryRows<{
    id: string;
    owner_id: string;
    name: string;
    description: string | null;
    schema_version: number;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, owner_id, name, description, schema_version, created_at, updated_at
       FROM projects
      ORDER BY created_at, id`,
  ).map((row) => ({
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

interface NoteJoinRow {
  document_id: string;
  project_id: string;
  kind: "note";
  title: string;
  current_revision_id: string;
  document_created_at: string;
  document_updated_at: string;
  revision_id: string;
  revision_number: number;
  parent_revision_id: string | null;
  content_json: string;
  metadata_json: string;
  revision_created_at: string;
}

function mapNoteJoin(row: NoteJoinRow): NoteDocumentView {
  const document: NoteDocument = {
    id: row.document_id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    currentRevisionId: row.current_revision_id,
    createdAt: row.document_created_at,
    updatedAt: row.document_updated_at,
  };
  const revision: DocumentRevision = {
    id: row.revision_id,
    documentId: row.document_id,
    revisionNumber: row.revision_number,
    parentRevisionId: row.parent_revision_id,
    content: parseJson<DocumentRevision["content"]>(row.content_json),
    metadata: parseJson<DocumentRevision["metadata"]>(row.metadata_json),
    createdAt: row.revision_created_at,
  };
  return { document, revision };
}

const NOTE_JOIN_SELECT = `
  SELECT
    d.id AS document_id,
    d.project_id,
    d.kind,
    d.title,
    d.current_revision_id,
    d.created_at AS document_created_at,
    d.updated_at AS document_updated_at,
    r.id AS revision_id,
    r.revision_number,
    r.parent_revision_id,
    r.content_json,
    r.metadata_json,
    r.created_at AS revision_created_at
  FROM documents d
  JOIN document_revisions r ON r.id = d.current_revision_id
`;

function listNotes(projectId: string): NoteDocumentView[] {
  return queryRows<NoteJoinRow>(
    `${NOTE_JOIN_SELECT}
      WHERE d.project_id = ?
      ORDER BY d.created_at, d.id`,
    [projectId],
  ).map(mapNoteJoin);
}

function getNote(documentId: string): NoteDocumentView | null {
  const [row] = queryRows<NoteJoinRow>(
    `${NOTE_JOIN_SELECT}
      WHERE d.id = ?
      LIMIT 1`,
    [documentId],
  );
  return row ? mapNoteJoin(row) : null;
}

function removeEntity(change: SyncChange): void {
  if (change.entityType === "project") {
    execute("DELETE FROM projects WHERE id = ?", [change.entityId]);
    return;
  }
  if (change.entityType === "document") {
    execute("DELETE FROM document_revisions WHERE document_id = ?", [
      change.entityId,
    ]);
    execute("DELETE FROM documents WHERE id = ?", [change.entityId]);
    return;
  }
  execute("DELETE FROM artifacts WHERE id = ?", [change.entityId]);
}

function upsertArtifact(artifact: Artifact): void {
  execute(
    `INSERT INTO artifacts (
       id, project_id, type, schema_version, mime_type, checksum_sha256,
       size_bytes, storage_key, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       project_id = excluded.project_id,
       type = excluded.type,
       schema_version = excluded.schema_version,
       mime_type = excluded.mime_type,
       checksum_sha256 = excluded.checksum_sha256,
       size_bytes = excluded.size_bytes,
       storage_key = excluded.storage_key,
       metadata_json = excluded.metadata_json,
       created_at = excluded.created_at`,
    [
      artifact.id,
      artifact.projectId,
      artifact.type,
      artifact.schemaVersion,
      artifact.mimeType,
      artifact.checksumSha256,
      artifact.sizeBytes,
      artifact.storageKey,
      json(artifact.metadata),
      artifact.createdAt,
    ],
  );
}

function applyRemoteChange(change: SyncChange): void {
  execute("BEGIN IMMEDIATE");
  try {
    if (change.kind === "conflict") {
      execute(
        `INSERT INTO conflicts (operation_id, change_json, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(operation_id) DO UPDATE SET
           change_json = excluded.change_json,
           created_at = excluded.created_at`,
        [change.operationId, json(change), change.createdAt],
      );
      execute(
        "UPDATE pending_operations SET status = 'conflict' WHERE operation_id = ?",
        [change.operationId],
      );
    } else if (change.kind === "tombstone") {
      removeEntity(change);
      putTombstone({
        entityType: change.entityType,
        entityId: change.entityId,
        cursor: change.cursor,
        payload: change.payload,
        createdAt: change.createdAt,
      });
    } else if (change.entityType === "project") {
      const project = change.payload.project as Project | undefined;
      if (project) upsertProject(project);
    } else if (change.entityType === "document") {
      const note = change.payload.note as NoteDocumentView | undefined;
      if (note) upsertNote(note);
    } else {
      const artifact = change.payload.artifact as Artifact | undefined;
      if (artifact) upsertArtifact(artifact);
    }

    setMeta("cursor", change.cursor);
    execute("COMMIT");
  } catch (error) {
    execute("ROLLBACK");
    throw error;
  }
}

async function initialize(): Promise<void> {
  if (database) return;
  const sqlite3 = await sqlite3InitModule();
  if (!sqlite3.oo1.OpfsDb) {
    throw new Error("SQLite OPFS backend is unavailable");
  }
  database = new sqlite3.oo1.OpfsDb(
    LOCAL_DATABASE_FILENAME,
  ) as unknown as SqliteDatabase;
  db().exec(LOCAL_SCHEMA_SQL);
  if (getMeta("cursor") === null) setMeta("cursor", "0");
}

async function handle(request: WorkerRequest): Promise<unknown> {
  if (request.type === "init") {
    await initialize();
    return null;
  }

  await initialize();

  switch (request.type) {
    case "transaction": {
      execute("BEGIN IMMEDIATE");
      try {
        for (const mutation of request.mutations) applyMutation(mutation);
        execute("COMMIT");
      } catch (error) {
        execute("ROLLBACK");
        throw error;
      }
      return null;
    }
    case "getDevice": {
      const raw = getMeta("device");
      return raw ? parseJson<LocalDeviceRecord>(raw) : null;
    }
    case "setDevice":
      setMeta("device", json(request.device));
      return null;
    case "getCursor":
      return getMeta("cursor") ?? "0";
    case "setCursor":
      setMeta("cursor", request.cursor);
      return null;
    case "listProjects":
      return listProjects();
    case "listNotes":
      return listNotes(request.projectId);
    case "getNote":
      return getNote(request.documentId);
    case "listPendingOperations":
      return queryRows<{ operation_json: string }>(
        `SELECT operation_json
           FROM pending_operations
          WHERE status = 'pending'
          ORDER BY created_at, operation_id
          LIMIT ?`,
        [Math.max(1, Math.min(500, request.limit))],
      ).map((row) => parseJson<SyncOperation>(row.operation_json));
    case "markOperationAcked":
      execute(
        `UPDATE pending_operations
            SET status = 'acked', ack_cursor = ?
          WHERE operation_id = ?`,
        [request.cursor, request.operationId],
      );
      setMeta("cursor", request.cursor);
      return null;
    case "applyRemoteChange":
      applyRemoteChange(request.change);
      return null;
    case "listConflicts":
      return queryRows<{
        operation_id: string;
        change_json: string;
        created_at: string;
      }>(
        `SELECT operation_id, change_json, created_at
           FROM conflicts
          ORDER BY created_at, operation_id`,
      ).map((row): LocalConflictRecord => ({
        operationId: row.operation_id,
        change: parseJson<SyncChange>(row.change_json),
        createdAt: row.created_at,
      }));
    case "clearConflict":
      execute("DELETE FROM conflicts WHERE operation_id = ?", [
        request.operationId,
      ]);
      execute("DELETE FROM pending_operations WHERE operation_id = ?", [
        request.operationId,
      ]);
      return null;
    case "close":
      database?.close();
      database = null;
      return null;
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  void handle(request)
    .then((value) => {
      const response: WorkerResponse = { id: request.id, ok: true, value };
      self.postMessage(response);
    })
    .catch((error: unknown) => {
      const response: WorkerResponse = {
        id: request.id,
        ok: false,
        error:
          error instanceof Error ? error.message : "Unknown worker failure",
      };
      self.postMessage(response);
    });
};

export {};
