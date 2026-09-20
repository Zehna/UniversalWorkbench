import { randomUUID } from "node:crypto";
import type {
  CreateNoteRecordInput,
  CreateWorkflowRecordInput,
  DocumentRepository,
  UpdateNoteRecordInput,
  UpdateNoteRecordResult,
  UpdateWorkflowRecordInput,
  UpdateWorkflowRecordResult,
} from "@uw/documents";
import {
  CreateNoteRequestSchema,
  CreateWorkflowRequestSchema,
  type DocumentRevision,
  type NoteDocument,
  type NoteDocumentView,
  type SyncOperation,
  type WorkflowDefinitionV1,
  type WorkflowDocument,
  type WorkflowDocumentView,
} from "@uw/contracts";
import type { SyncDocumentStore, SyncEntityApplyResult } from "@uw/sync";
import type { Pool, PoolClient, QueryResultRow } from "pg";

interface NoteRow extends QueryResultRow {
  document_id: string;
  project_id: string;
  kind: "note";
  title: string;
  current_revision_id: string;
  document_created_at: Date;
  document_updated_at: Date;
  revision_id: string;
  revision_number: number;
  parent_revision_id: string | null;
  content: { body: string };
  metadata: Record<string, unknown>;
  revision_created_at: Date;
}

interface WorkflowRow extends QueryResultRow {
  document_id: string;
  project_id: string;
  kind: "workflow";
  title: string;
  current_revision_id: string;
  document_created_at: Date;
  document_updated_at: Date;
  revision_id: string;
  revision_number: number;
  parent_revision_id: string | null;
  content: {
    kind: "workflow";
    workflow: WorkflowDefinitionV1;
  };
  metadata: Record<string, unknown>;
  revision_created_at: Date;
}

interface WorkflowSummaryRow extends QueryResultRow {
  id: string;
  project_id: string;
  kind: "workflow";
  title: string;
  current_revision_id: string;
  created_at: Date;
  updated_at: Date;
}

interface DocumentSummaryRow extends QueryResultRow {
  id: string;
  project_id: string;
  kind: "note";
  title: string;
  current_revision_id: string;
  created_at: Date;
  updated_at: Date;
}

interface RevisionRow extends QueryResultRow {
  id: string;
  document_id: string;
  revision_number: number;
  parent_revision_id: string | null;
  content: { body: string };
  metadata: Record<string, unknown>;
  created_at: Date;
}

interface LockedDocumentRow extends QueryResultRow {
  id: string;
  project_id: string;
  title: string;
  current_revision_id: string;
  created_at: Date;
  revision_number: number;
}

function mapDocument(row: DocumentSummaryRow): NoteDocument {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    currentRevisionId: row.current_revision_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapRevision(row: RevisionRow): DocumentRevision {
  return {
    id: row.id,
    documentId: row.document_id,
    revisionNumber: row.revision_number,
    parentRevisionId: row.parent_revision_id,
    content: row.content,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
  };
}

function mapView(row: NoteRow): NoteDocumentView {
  return {
    document: {
      id: row.document_id,
      projectId: row.project_id,
      kind: row.kind,
      title: row.title,
      currentRevisionId: row.current_revision_id,
      createdAt: row.document_created_at.toISOString(),
      updatedAt: row.document_updated_at.toISOString(),
    },
    revision: {
      id: row.revision_id,
      documentId: row.document_id,
      revisionNumber: row.revision_number,
      parentRevisionId: row.parent_revision_id,
      content: row.content,
      metadata: row.metadata,
      createdAt: row.revision_created_at.toISOString(),
    },
  };
}

function mapWorkflowDocument(row: WorkflowSummaryRow): WorkflowDocument {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: "workflow",
    title: row.title,
    currentRevisionId: row.current_revision_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapWorkflowView(row: WorkflowRow): WorkflowDocumentView {
  return {
    document: {
      id: row.document_id,
      projectId: row.project_id,
      kind: "workflow",
      title: row.title,
      currentRevisionId: row.current_revision_id,
      createdAt: row.document_created_at.toISOString(),
      updatedAt: row.document_updated_at.toISOString(),
    },
    revision: {
      id: row.revision_id,
      documentId: row.document_id,
      revisionNumber: row.revision_number,
      parentRevisionId: row.parent_revision_id,
      content: row.content,
      metadata: row.metadata,
      createdAt: row.revision_created_at.toISOString(),
    },
  };
}

async function findOwnedNote(
  db: Pool | PoolClient,
  ownerId: string,
  projectId: string,
  documentId: string,
): Promise<NoteDocumentView | null> {
  const result = await db.query<NoteRow>(
    `select
       d.id as document_id,
       d.project_id,
       d.kind,
       d.title,
       d.current_revision_id,
       d.created_at as document_created_at,
       d.updated_at as document_updated_at,
       r.id as revision_id,
       r.revision_number,
       r.parent_revision_id,
       r.content,
       r.metadata,
       r.created_at as revision_created_at
     from documents d
     join projects p on p.id = d.project_id
     join document_revisions r on r.id = d.current_revision_id
    where p.owner_id = $1
      and p.deleted_at is null
      and d.project_id = $2
      and d.id = $3
      and d.deleted_at is null
      and d.kind = 'note'
    limit 1`,
    [ownerId, projectId, documentId],
  );
  const row = result.rows[0];
  return row ? mapView(row) : null;
}

function sameCreatedNote(
  value: NoteDocumentView,
  input: CreateNoteRecordInput,
): boolean {
  return (
    value.document.id === input.documentId &&
    value.document.projectId === input.projectId &&
    value.document.title === input.title &&
    value.revision.id === input.revisionId &&
    value.revision.documentId === input.documentId &&
    value.revision.revisionNumber === 1 &&
    value.revision.content.body === input.body
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

async function rollback(client: PoolClient) {
  try {
    await client.query("rollback");
  } catch {
    // Preserve the original transaction error.
  }
}

export function createPostgresDocumentRepository(
  pool: Pool,
): DocumentRepository {
  return {
    async projectExists(ownerId, projectId) {
      const result = await pool.query(
        `select 1
           from projects
          where id = $1
            and owner_id = $2
            and deleted_at is null
          limit 1`,
        [projectId, ownerId],
      );
      return result.rowCount === 1;
    },

    async createNote(input: CreateNoteRecordInput) {
      const client = await pool.connect();
      try {
        await client.query("begin");

        const existing = await findOwnedNote(
          client,
          input.ownerId,
          input.projectId,
          input.documentId,
        );
        if (existing) {
          await client.query("rollback");
          if (!sameCreatedNote(existing, input)) {
            throw new Error("Document identity collision");
          }
          return existing;
        }

        const project = await client.query(
          `select 1
             from projects
            where id = $1
              and owner_id = $2
              and deleted_at is null
            limit 1`,
          [input.projectId, input.ownerId],
        );
        if (project.rowCount !== 1) {
          await client.query("rollback");
          return null;
        }

        await client.query(
          `insert into documents (
             id,
             project_id,
             kind,
             title,
             current_revision_id,
             created_at,
             updated_at
           ) values ($1, $2, 'note', $3, null, $4, $4)`,
          [input.documentId, input.projectId, input.title, input.createdAt],
        );

        await client.query(
          `insert into document_revisions (
             id,
             document_id,
             revision_number,
             parent_revision_id,
             content,
             metadata,
             created_at
           ) values ($1, $2, 1, null, $3, $4, $5)`,
          [
            input.revisionId,
            input.documentId,
            { body: input.body },
            {},
            input.createdAt,
          ],
        );

        await client.query(
          `update documents
              set current_revision_id = $1
            where id = $2`,
          [input.revisionId, input.documentId],
        );

        await client.query("commit");

        const createdAt = input.createdAt.toISOString();
        return {
          document: {
            id: input.documentId,
            projectId: input.projectId,
            kind: "note",
            title: input.title,
            currentRevisionId: input.revisionId,
            createdAt,
            updatedAt: createdAt,
          },
          revision: {
            id: input.revisionId,
            documentId: input.documentId,
            revisionNumber: 1,
            parentRevisionId: null,
            content: { body: input.body },
            metadata: {},
            createdAt,
          },
        };
      } catch (error) {
        await rollback(client);
        if (isUniqueViolation(error)) {
          const existing = await findOwnedNote(
            client,
            input.ownerId,
            input.projectId,
            input.documentId,
          );
          if (existing && sameCreatedNote(existing, input)) {
            return existing;
          }
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async createWorkflow(input: CreateWorkflowRecordInput) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const project = await client.query(
          `select 1 from projects
            where id = $1 and owner_id = $2 and deleted_at is null
            limit 1`,
          [input.projectId, input.ownerId],
        );
        if (project.rowCount !== 1) {
          await client.query("rollback");
          return null;
        }

        await client.query(
          `insert into documents (
             id, project_id, kind, title, current_revision_id, created_at, updated_at
           ) values ($1, $2, 'workflow', $3, null, $4, $4)`,
          [input.documentId, input.projectId, input.title, input.createdAt],
        );
        await client.query(
          `insert into document_revisions (
             id, document_id, revision_number, parent_revision_id,
             content, metadata, created_at
           ) values ($1, $2, 1, null, $3, $4, $5)`,
          [
            input.revisionId,
            input.documentId,
            { kind: "workflow", workflow: input.workflow },
            {},
            input.createdAt,
          ],
        );
        await client.query(
          `update documents set current_revision_id = $1 where id = $2`,
          [input.revisionId, input.documentId],
        );
        await client.query("commit");

        const createdAt = input.createdAt.toISOString();
        return {
          document: {
            id: input.documentId,
            projectId: input.projectId,
            kind: "workflow",
            title: input.title,
            currentRevisionId: input.revisionId,
            createdAt,
            updatedAt: createdAt,
          },
          revision: {
            id: input.revisionId,
            documentId: input.documentId,
            revisionNumber: 1,
            parentRevisionId: null,
            content: {
              kind: "workflow",
              workflow: structuredClone(input.workflow),
            },
            metadata: {},
            createdAt,
          },
        };
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async listNotes(ownerId, projectId) {
      const result = await pool.query<DocumentSummaryRow>(
        `select
           d.id,
           d.project_id,
           d.kind,
           d.title,
           d.current_revision_id,
           d.created_at,
           d.updated_at
         from documents d
         join projects p on p.id = d.project_id
        where p.owner_id = $1
          and p.deleted_at is null
          and d.project_id = $2
          and d.deleted_at is null
          and d.kind = 'note'
          and d.current_revision_id is not null
        order by d.created_at, d.id`,
        [ownerId, projectId],
      );
      return result.rows.map(mapDocument);
    },

    async listWorkflows(ownerId, projectId) {
      const result = await pool.query<WorkflowSummaryRow>(
        `select
           d.id, d.project_id, d.kind, d.title, d.current_revision_id,
           d.created_at, d.updated_at
         from documents d
         join projects p on p.id = d.project_id
        where p.owner_id = $1
          and p.deleted_at is null
          and d.project_id = $2
          and d.deleted_at is null
          and d.kind = 'workflow'
          and d.current_revision_id is not null
        order by d.created_at, d.id`,
        [ownerId, projectId],
      );
      return result.rows.map(mapWorkflowDocument);
    },

    getNote(ownerId, projectId, documentId) {
      return findOwnedNote(pool, ownerId, projectId, documentId);
    },

    async getWorkflow(ownerId, projectId, documentId) {
      const result = await pool.query<WorkflowRow>(
        `select
           d.id as document_id,
           d.project_id,
           d.kind,
           d.title,
           d.current_revision_id,
           d.created_at as document_created_at,
           d.updated_at as document_updated_at,
           r.id as revision_id,
           r.revision_number,
           r.parent_revision_id,
           r.content,
           r.metadata,
           r.created_at as revision_created_at
         from documents d
         join projects p on p.id = d.project_id
         join document_revisions r on r.id = d.current_revision_id
        where p.owner_id = $1
          and p.deleted_at is null
          and d.project_id = $2
          and d.id = $3
          and d.deleted_at is null
          and d.kind = 'workflow'
        limit 1`,
        [ownerId, projectId, documentId],
      );
      const row = result.rows[0];
      return row ? mapWorkflowView(row) : null;
    },

    async listRevisions(ownerId, projectId, documentId) {
      const result = await pool.query<RevisionRow>(
        `select
           r.id,
           r.document_id,
           r.revision_number,
           r.parent_revision_id,
           r.content,
           r.metadata,
           r.created_at
         from document_revisions r
         join documents d on d.id = r.document_id
         join projects p on p.id = d.project_id
        where p.owner_id = $1
          and p.deleted_at is null
          and d.project_id = $2
          and d.id = $3
          and d.deleted_at is null
          and d.kind = 'note'
        order by r.revision_number`,
        [ownerId, projectId, documentId],
      );
      if (result.rows.length === 0) return null;
      return result.rows.map(mapRevision);
    },

    async updateNote(
      input: UpdateNoteRecordInput,
    ): Promise<UpdateNoteRecordResult> {
      const client = await pool.connect();
      try {
        await client.query("begin");

        const locked = await client.query<LockedDocumentRow>(
          `select
             d.id,
             d.project_id,
             d.title,
             d.current_revision_id,
             d.created_at,
             r.revision_number
           from documents d
           join projects p on p.id = d.project_id
           join document_revisions r on r.id = d.current_revision_id
          where p.owner_id = $1
            and p.deleted_at is null
            and d.project_id = $2
            and d.id = $3
            and d.deleted_at is null
            and d.kind = 'note'
          for update of d`,
          [input.ownerId, input.projectId, input.documentId],
        );
        const current = locked.rows[0];
        if (!current) {
          await client.query("rollback");
          return { status: "not_found" };
        }

        if (current.current_revision_id !== input.baseRevisionId) {
          await client.query("rollback");
          return {
            status: "conflict",
            currentRevisionId: current.current_revision_id,
          };
        }

        const nextRevisionNumber = current.revision_number + 1;
        await client.query(
          `insert into document_revisions (
             id,
             document_id,
             revision_number,
             parent_revision_id,
             content,
             metadata,
             created_at
           ) values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            input.revisionId,
            input.documentId,
            nextRevisionNumber,
            current.current_revision_id,
            { body: input.body },
            {},
            input.updatedAt,
          ],
        );

        await client.query(
          `update documents
              set title = $1,
                  current_revision_id = $2,
                  updated_at = $3
            where id = $4`,
          [input.title, input.revisionId, input.updatedAt, input.documentId],
        );

        await client.query("commit");

        return {
          status: "updated",
          value: {
            document: {
              id: input.documentId,
              projectId: input.projectId,
              kind: "note",
              title: input.title,
              currentRevisionId: input.revisionId,
              createdAt: current.created_at.toISOString(),
              updatedAt: input.updatedAt.toISOString(),
            },
            revision: {
              id: input.revisionId,
              documentId: input.documentId,
              revisionNumber: nextRevisionNumber,
              parentRevisionId: current.current_revision_id,
              content: { body: input.body },
              metadata: {},
              createdAt: input.updatedAt.toISOString(),
            },
          },
        };
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async updateWorkflow(
      input: UpdateWorkflowRecordInput,
    ): Promise<UpdateWorkflowRecordResult> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const locked = await client.query<LockedDocumentRow>(
          `select
             d.id, d.project_id, d.title, d.current_revision_id,
             d.created_at, r.revision_number
           from documents d
           join projects p on p.id = d.project_id
           join document_revisions r on r.id = d.current_revision_id
          where p.owner_id = $1
            and p.deleted_at is null
            and d.project_id = $2
            and d.id = $3
            and d.deleted_at is null
            and d.kind = 'workflow'
          for update of d`,
          [input.ownerId, input.projectId, input.documentId],
        );
        const current = locked.rows[0];
        if (!current) {
          await client.query("rollback");
          return { status: "not_found" };
        }
        if (current.current_revision_id !== input.baseRevisionId) {
          await client.query("rollback");
          return {
            status: "conflict",
            currentRevisionId: current.current_revision_id,
          };
        }

        const nextRevisionNumber = current.revision_number + 1;
        await client.query(
          `insert into document_revisions (
             id, document_id, revision_number, parent_revision_id,
             content, metadata, created_at
           ) values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            input.revisionId,
            input.documentId,
            nextRevisionNumber,
            current.current_revision_id,
            { kind: "workflow", workflow: input.workflow },
            {},
            input.updatedAt,
          ],
        );
        await client.query(
          `update documents
              set title = $1, current_revision_id = $2, updated_at = $3
            where id = $4`,
          [input.title, input.revisionId, input.updatedAt, input.documentId],
        );
        await client.query("commit");

        return {
          status: "updated",
          value: {
            document: {
              id: input.documentId,
              projectId: input.projectId,
              kind: "workflow",
              title: input.title,
              currentRevisionId: input.revisionId,
              createdAt: current.created_at.toISOString(),
              updatedAt: input.updatedAt.toISOString(),
            },
            revision: {
              id: input.revisionId,
              documentId: input.documentId,
              revisionNumber: nextRevisionNumber,
              parentRevisionId: current.current_revision_id,
              content: {
                kind: "workflow",
                workflow: structuredClone(input.workflow),
              },
              metadata: {},
              createdAt: input.updatedAt.toISOString(),
            },
          },
        };
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

interface SyncLockedDocumentRow extends QueryResultRow {
  id: string;
  project_id: string;
  kind: "note" | "workflow";
  title: string;
  current_revision_id: string | null;
  created_at: Date;
  deleted_at: Date | null;
  revision_number: number | null;
  content: { body?: unknown } | { kind?: unknown; workflow?: unknown } | null;
}

function syncDocumentConflict(
  current: SyncLockedDocumentRow | null,
): SyncEntityApplyResult {
  if (!current) {
    return {
      status: "conflict",
      currentRevision: null,
      current: { missing: true },
    };
  }
  if (current.deleted_at) {
    return {
      status: "conflict",
      currentRevision: current.current_revision_id,
      current: { deleted: true },
    };
  }
  return {
    status: "conflict",
    currentRevision: current.current_revision_id,
    current:
      current.kind === "workflow"
        ? {
            id: current.id,
            kind: "workflow",
            title: current.title,
            workflow:
              current.content &&
              "kind" in current.content &&
              current.content.kind === "workflow" &&
              "workflow" in current.content
                ? current.content.workflow
                : null,
            currentRevisionId: current.current_revision_id,
          }
        : {
            id: current.id,
            title: current.title,
            body:
              current.content &&
              "body" in current.content &&
              typeof current.content.body === "string"
                ? current.content.body
                : "",
            currentRevisionId: current.current_revision_id,
          },
  };
}

async function lockSyncDocument(
  client: PoolClient,
  ownerId: string,
  projectId: string,
  documentId: string,
): Promise<SyncLockedDocumentRow | null> {
  const result = await client.query<SyncLockedDocumentRow>(
    `select
       d.id,
       d.project_id,
       d.kind,
       d.title,
       d.current_revision_id,
       d.created_at,
       d.deleted_at,
       r.revision_number,
       r.content
     from documents d
     join projects p on p.id = d.project_id
     left join document_revisions r on r.id = d.current_revision_id
    where p.owner_id = $1
      and p.deleted_at is null
      and d.project_id = $2
      and d.id = $3
    for update of d`,
    [ownerId, projectId, documentId],
  );
  return result.rows[0] ?? null;
}

function noteViewFromSyncInput(input: {
  documentId: string;
  projectId: string;
  title: string;
  body: string;
  revisionId: string;
  revisionNumber: number;
  parentRevisionId: string | null;
  createdAt: Date;
  documentCreatedAt: Date;
}): NoteDocumentView {
  return {
    document: {
      id: input.documentId,
      projectId: input.projectId,
      kind: "note",
      title: input.title,
      currentRevisionId: input.revisionId,
      createdAt: input.documentCreatedAt.toISOString(),
      updatedAt: input.createdAt.toISOString(),
    },
    revision: {
      id: input.revisionId,
      documentId: input.documentId,
      revisionNumber: input.revisionNumber,
      parentRevisionId: input.parentRevisionId,
      content: { body: input.body },
      metadata: {},
      createdAt: input.createdAt.toISOString(),
    },
  };
}

function workflowViewFromSyncInput(input: {
  documentId: string;
  projectId: string;
  title: string;
  workflow: WorkflowDefinitionV1;
  revisionId: string;
  revisionNumber: number;
  parentRevisionId: string | null;
  createdAt: Date;
  documentCreatedAt: Date;
}): WorkflowDocumentView {
  return {
    document: {
      id: input.documentId,
      projectId: input.projectId,
      kind: "workflow",
      title: input.title,
      currentRevisionId: input.revisionId,
      createdAt: input.documentCreatedAt.toISOString(),
      updatedAt: input.createdAt.toISOString(),
    },
    revision: {
      id: input.revisionId,
      documentId: input.documentId,
      revisionNumber: input.revisionNumber,
      parentRevisionId: input.parentRevisionId,
      content: {
        kind: "workflow",
        workflow: structuredClone(input.workflow),
      },
      metadata: {},
      createdAt: input.createdAt.toISOString(),
    },
  };
}

export function createPostgresSyncDocumentStore(pool: Pool): SyncDocumentStore {
  return {
    async apply(ownerId, operation: SyncOperation) {
      if (
        operation.entityType !== "document" ||
        !operation.action.startsWith("document.")
      ) {
        throw new Error(
          "Document sync store received a non-document operation",
        );
      }

      const projectId = operation.projectId;
      if (!projectId) {
        return {
          status: "conflict",
          currentRevision: null,
          current: { missing: true },
        };
      }

      const client = await pool.connect();
      try {
        await client.query("begin");

        if (operation.action === "document.create") {
          const isWorkflow = operation.payload.kind === "workflow";
          const noteInput = isWorkflow
            ? null
            : CreateNoteRequestSchema.parse(operation.payload);
          const workflowInput = isWorkflow
            ? CreateWorkflowRequestSchema.parse(operation.payload)
            : null;
          const title = workflowInput?.title ?? noteInput!.title;
          const project = await client.query(
            `select 1
               from projects
              where id = $1
                and owner_id = $2
                and deleted_at is null
              limit 1`,
            [projectId, ownerId],
          );
          if (project.rowCount !== 1) {
            await client.query("rollback");
            return {
              status: "conflict",
              currentRevision: null,
              current: { missing: true },
            };
          }

          const existing = await client.query<SyncLockedDocumentRow>(
            `select
               d.id,
               d.project_id,
               d.title,
               d.current_revision_id,
               d.created_at,
               d.deleted_at,
               r.revision_number,
               r.content
             from documents d
             left join document_revisions r on r.id = d.current_revision_id
            where d.id = $1
            limit 1`,
            [operation.entityId],
          );
          if (existing.rows[0]) {
            await client.query("rollback");
            return syncDocumentConflict(existing.rows[0]);
          }

          const revisionId = randomUUID();
          const createdAt = new Date(operation.createdAt);
          await client.query(
            `insert into documents (
               id, project_id, kind, title, current_revision_id,
               deleted_at, created_at, updated_at
             ) values ($1,$2,$3,$4,null,null,$5,$5)`,
            [
              operation.entityId,
              projectId,
              isWorkflow ? "workflow" : "note",
              title,
              createdAt,
            ],
          );
          await client.query(
            `insert into document_revisions (
               id, document_id, revision_number, parent_revision_id,
               content, metadata, created_at
             ) values ($1,$2,1,null,$3,$4,$5)`,
            [
              revisionId,
              operation.entityId,
              isWorkflow
                ? { kind: "workflow", workflow: workflowInput!.workflow }
                : { body: noteInput!.body },
              {},
              createdAt,
            ],
          );
          await client.query(
            `update documents
                set current_revision_id = $1
              where id = $2`,
            [revisionId, operation.entityId],
          );
          await client.query("commit");

          if (isWorkflow) {
            const workflow = workflowViewFromSyncInput({
              documentId: operation.entityId,
              projectId,
              title,
              workflow: workflowInput!.workflow,
              revisionId,
              revisionNumber: 1,
              parentRevisionId: null,
              createdAt,
              documentCreatedAt: createdAt,
            });
            return {
              status: "applied",
              kind: "upsert",
              revision: revisionId,
              payload: { workflow },
            };
          }

          const note = noteViewFromSyncInput({
            documentId: operation.entityId,
            projectId,
            title,
            body: noteInput!.body,
            revisionId,
            revisionNumber: 1,
            parentRevisionId: null,
            createdAt,
            documentCreatedAt: createdAt,
          });
          return {
            status: "applied",
            kind: "upsert",
            revision: revisionId,
            payload: { note },
          };
        }

        const current = await lockSyncDocument(
          client,
          ownerId,
          projectId,
          operation.entityId,
        );
        if (
          !current ||
          current.deleted_at ||
          current.current_revision_id !== operation.baseRevision
        ) {
          await client.query("rollback");
          return syncDocumentConflict(current);
        }

        if (operation.action === "document.delete") {
          await client.query(
            `update documents
                set deleted_at = now(),
                    updated_at = now()
              where id = $1`,
            [operation.entityId],
          );
          await client.query("commit");
          return {
            status: "applied",
            kind: "tombstone",
            revision: null,
            payload: {
              id: operation.entityId,
              projectId,
              deleted: true,
            },
          };
        }

        const isWorkflow = current.kind === "workflow";
        const noteInput = isWorkflow
          ? null
          : CreateNoteRequestSchema.parse(operation.payload);
        const workflowInput = isWorkflow
          ? CreateWorkflowRequestSchema.parse(operation.payload)
          : null;
        const title = workflowInput?.title ?? noteInput!.title;
        const revisionId = randomUUID();
        const updatedAt = new Date();
        const revisionNumber = (current.revision_number ?? 0) + 1;
        await client.query(
          `insert into document_revisions (
             id, document_id, revision_number, parent_revision_id,
             content, metadata, created_at
           ) values ($1,$2,$3,$4,$5,$6,$7)`,
          [
            revisionId,
            operation.entityId,
            revisionNumber,
            current.current_revision_id,
            isWorkflow
              ? { kind: "workflow", workflow: workflowInput!.workflow }
              : { body: noteInput!.body },
            {},
            updatedAt,
          ],
        );
        await client.query(
          `update documents
              set title = $1,
                  current_revision_id = $2,
                  updated_at = $3
            where id = $4`,
          [title, revisionId, updatedAt, operation.entityId],
        );
        await client.query("commit");

        if (isWorkflow) {
          const workflow = workflowViewFromSyncInput({
            documentId: operation.entityId,
            projectId,
            title,
            workflow: workflowInput!.workflow,
            revisionId,
            revisionNumber,
            parentRevisionId: current.current_revision_id,
            createdAt: updatedAt,
            documentCreatedAt: current.created_at,
          });
          return {
            status: "applied",
            kind: "upsert",
            revision: revisionId,
            payload: { workflow },
          };
        }

        const note = noteViewFromSyncInput({
          documentId: operation.entityId,
          projectId,
          title,
          body: noteInput!.body,
          revisionId,
          revisionNumber,
          parentRevisionId: current.current_revision_id,
          createdAt: updatedAt,
          documentCreatedAt: current.created_at,
        });
        return {
          status: "applied",
          kind: "upsert",
          revision: revisionId,
          payload: { note },
        };
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
