import { randomUUID } from "node:crypto";
import type { WorkflowDefinitionV1 } from "@uw/contracts";
import {
  createDocumentService,
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

const workflow: WorkflowDefinitionV1 = {
  schemaVersion: 1,
  name: "Golden workflow",
  nodes: [],
  edges: [],
  outputs: [],
};

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

async function insertProject(ownerId: string) {
  const id = randomUUID();
  await pool.query(
    "insert into projects (id, owner_id, name) values ($1, $2, 'Workflow Project')",
    [id, ownerId],
  );
  return id;
}

function service() {
  return createDocumentService({
    documents: createPostgresDocumentRepository(pool),
    audit: createPostgresAuditRepository(pool),
    clock: new SystemClock(),
    idGenerator: new UuidGenerator(),
    validateWorkflow() {},
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

describe("PostgreSQL workflow documents", () => {
  it("persists workflow revisions without changing legacy note storage", async () => {
    const ownerId = await insertOwner();
    const projectId = await insertProject(ownerId);
    const documents = service();

    const created = await documents.createWorkflow(
      ownerId,
      projectId,
      { title: "Golden", workflow },
      randomUUID(),
    );
    const updated = await documents.updateWorkflow(
      ownerId,
      projectId,
      created.document.id,
      {
        title: "Golden v2",
        workflow: { ...workflow, name: "Golden v2" },
        baseRevisionId: created.revision.id,
      },
      randomUUID(),
    );

    expect(updated.document.kind).toBe("workflow");
    expect(updated.revision.revisionNumber).toBe(2);
    expect(updated.revision.parentRevisionId).toBe(created.revision.id);

    const rows = await pool.query<{ content: unknown }>(
      "select content from document_revisions where document_id = $1 order by revision_number",
      [created.document.id],
    );
    expect(rows.rows).toEqual([
      {
        content: {
          kind: "workflow",
          workflow,
        },
      },
      {
        content: {
          kind: "workflow",
          workflow: { ...workflow, name: "Golden v2" },
        },
      },
    ]);
  });

  it("rejects stale workflow updates and preserves canonical revision", async () => {
    const ownerId = await insertOwner();
    const projectId = await insertProject(ownerId);
    const documents = service();

    const created = await documents.createWorkflow(
      ownerId,
      projectId,
      { title: "Golden", workflow },
      randomUUID(),
    );
    const updated = await documents.updateWorkflow(
      ownerId,
      projectId,
      created.document.id,
      {
        title: "Golden v2",
        workflow: { ...workflow, name: "Golden v2" },
        baseRevisionId: created.revision.id,
      },
      randomUUID(),
    );

    await expect(
      documents.updateWorkflow(
        ownerId,
        projectId,
        created.document.id,
        {
          title: "Stale",
          workflow,
          baseRevisionId: created.revision.id,
        },
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(RevisionConflictError);

    await expect(
      documents.assertCanonicalWorkflowRevision(
        ownerId,
        projectId,
        created.document.id,
        updated.revision.id,
      ),
    ).resolves.toEqual(updated);
  });
});
