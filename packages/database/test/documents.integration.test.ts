import { randomUUID } from "node:crypto";
import {
  createDocumentService,
  DocumentNotFoundError,
  RevisionConflictError,
} from "@uw/documents";
import { SystemClock, UuidGenerator } from "@uw/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabasePool,
  createDatabasePool,
  createPostgresAuditRepository,
  createPostgresDocumentRepository,
  migrateDatabase,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

const pool = createDatabasePool(databaseUrl);

async function resetDatabaseSchemas() {
  await pool.query("drop schema if exists public cascade");
  await pool.query("drop schema if exists drizzle cascade");
  await pool.query("create schema public");
}

async function insertOwner() {
  const id = randomUUID();
  await pool.query(
    `insert into owner_accounts
      (id, singleton_key, username, password_algorithm, password_salt, password_hash, password_parameters)
     values ($1, 1, $2, 'argon2id', 'salt', 'hash', '{}'::jsonb)`,
    [id, `owner-${id}`],
  );
  return id;
}

async function insertProject(ownerId: string, name = "Research Project") {
  const id = randomUUID();
  await pool.query(
    "insert into projects (id, owner_id, name) values ($1, $2, $3)",
    [id, ownerId, name],
  );
  return id;
}

function createService() {
  return createDocumentService({
    documents: createPostgresDocumentRepository(pool),
    audit: createPostgresAuditRepository(pool),
    clock: new SystemClock(),
    idGenerator: new UuidGenerator(),
  });
}

beforeEach(async () => {
  await resetDatabaseSchemas();
  await migrateDatabase(pool);
});

afterAll(async () => {
  await resetDatabaseSchemas();
  await closeDatabasePool(pool);
});

describe("PostgreSQL document revisions", () => {
  it("creates a note with immutable revision 1 and audits the action", async () => {
    const ownerId = await insertOwner();
    const projectId = await insertProject(ownerId);
    const traceId = randomUUID();
    const service = createService();

    const created = await service.createNote(
      ownerId,
      projectId,
      { title: "Field Notes", body: "First observation" },
      traceId,
    );

    expect(created.document).toMatchObject({
      projectId,
      kind: "note",
      title: "Field Notes",
      currentRevisionId: created.revision.id,
    });
    expect(created.revision).toMatchObject({
      documentId: created.document.id,
      revisionNumber: 1,
      parentRevisionId: null,
      content: { body: "First observation" },
    });

    const audit = await pool.query<{
      action: string;
      project_id: string | null;
      target_id: string | null;
      trace_id: string;
      metadata: Record<string, unknown>;
    }>(
      `select action, project_id, target_id, trace_id, metadata
         from action_audit`,
    );

    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: "document.create",
      project_id: projectId,
      target_id: created.document.id,
      trace_id: traceId,
      metadata: { fields: ["body", "title"] },
    });
    expect(JSON.stringify(audit.rows[0]?.metadata)).not.toContain(
      "First observation",
    );
  });

  it("replays an execution note identity without creating a duplicate document", async () => {
    const ownerId = await insertOwner();
    const projectId = await insertProject(ownerId);
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const traceId = randomUUID();
    const { createExecutionNoteWriter } = await import("@uw/documents");
    const writer = createExecutionNoteWriter({
      documents: createPostgresDocumentRepository(pool),
      audit: createPostgresAuditRepository(pool),
      clock: new SystemClock(),
      idGenerator: new UuidGenerator(),
    });

    const input = {
      documentId,
      revisionId,
      title: "Generated",
      body: "Stable body",
    };
    const first = await writer.createNote(ownerId, projectId, input, traceId);
    const replay = await writer.createNote(ownerId, projectId, input, traceId);

    expect(replay).toEqual(first);

    const documents = await pool.query<{ count: string }>(
      "select count(*)::text as count from documents where id = $1",
      [documentId],
    );
    const revisions = await pool.query<{ count: string }>(
      "select count(*)::text as count from document_revisions where id = $1",
      [revisionId],
    );
    expect(documents.rows[0]?.count).toBe("1");
    expect(revisions.rows[0]?.count).toBe("1");
  });

  it("appends revision 2 without changing revision 1", async () => {
    const ownerId = await insertOwner();
    const projectId = await insertProject(ownerId);
    const service = createService();
    const created = await service.createNote(
      ownerId,
      projectId,
      { title: "Field Notes", body: "Version one" },
      randomUUID(),
    );

    const updated = await service.updateNote(
      ownerId,
      projectId,
      created.document.id,
      {
        title: "Field Notes Revised",
        body: "Version two",
        baseRevisionId: created.revision.id,
      },
      randomUUID(),
    );

    expect(updated.document).toMatchObject({
      id: created.document.id,
      title: "Field Notes Revised",
      currentRevisionId: updated.revision.id,
    });
    expect(updated.revision).toMatchObject({
      documentId: created.document.id,
      revisionNumber: 2,
      parentRevisionId: created.revision.id,
      content: { body: "Version two" },
    });

    const revisions = await service.listRevisions(
      ownerId,
      projectId,
      created.document.id,
    );
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({
      id: created.revision.id,
      revisionNumber: 1,
      parentRevisionId: null,
      content: { body: "Version one" },
    });
    expect(revisions[1]).toMatchObject({
      id: updated.revision.id,
      revisionNumber: 2,
      parentRevisionId: created.revision.id,
      content: { body: "Version two" },
    });

    const original = await pool.query<{
      content: { body: string };
    }>("select content from document_revisions where id = $1", [
      created.revision.id,
    ]);
    expect(original.rows[0]?.content).toEqual({ body: "Version one" });
  });

  it("rejects a stale base revision and preserves the current revision", async () => {
    const ownerId = await insertOwner();
    const projectId = await insertProject(ownerId);
    const service = createService();
    const created = await service.createNote(
      ownerId,
      projectId,
      { title: "Field Notes", body: "Version one" },
      randomUUID(),
    );
    const updated = await service.updateNote(
      ownerId,
      projectId,
      created.document.id,
      {
        title: "Field Notes",
        body: "Version two",
        baseRevisionId: created.revision.id,
      },
      randomUUID(),
    );

    let conflict: unknown;
    try {
      await service.updateNote(
        ownerId,
        projectId,
        created.document.id,
        {
          title: "Stale write",
          body: "Should not persist",
          baseRevisionId: created.revision.id,
        },
        randomUUID(),
      );
    } catch (error) {
      conflict = error;
    }

    expect(conflict).toBeInstanceOf(RevisionConflictError);
    expect(conflict).toMatchObject({
      currentRevisionId: updated.revision.id,
    });

    const current = await service.getNote(
      ownerId,
      projectId,
      created.document.id,
    );
    expect(current).toEqual(updated);

    const revisions = await service.listRevisions(
      ownerId,
      projectId,
      created.document.id,
    );
    expect(revisions).toHaveLength(2);

    const updateAudits = await pool.query<{ count: string }>(
      "select count(*) from action_audit where action = 'document.update'",
    );
    expect(updateAudits.rows[0]?.count).toBe("1");
  });

  it("conceals notes across owner and project boundaries", async () => {
    const ownerId = await insertOwner();
    const otherActorId = randomUUID();
    const projectId = await insertProject(ownerId, "Private Project");
    const otherProjectId = await insertProject(ownerId, "Other Project");
    const service = createService();
    const created = await service.createNote(
      ownerId,
      projectId,
      { title: "Private Note", body: "Private body" },
      randomUUID(),
    );

    await expect(
      service.getNote(otherActorId, projectId, created.document.id),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);
    await expect(
      service.getNote(ownerId, otherProjectId, created.document.id),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);

    await expect(
      service.updateNote(
        otherActorId,
        projectId,
        created.document.id,
        {
          title: "Hijacked",
          body: "Hijacked",
          baseRevisionId: created.revision.id,
        },
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);

    await expect(
      service.updateNote(
        ownerId,
        otherProjectId,
        created.document.id,
        {
          title: "Moved",
          body: "Moved",
          baseRevisionId: created.revision.id,
        },
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);

    await expect(
      service.getNote(ownerId, projectId, created.document.id),
    ).resolves.toEqual(created);
  });
});
