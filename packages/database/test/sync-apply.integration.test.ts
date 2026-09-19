import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { SyncOperation } from "@uw/contracts";
import { createSyncOperationApplier } from "@uw/sync";
import {
  closeDatabasePool,
  createDatabasePool,
  createPostgresAuditRepository,
  createPostgresSyncDocumentStore,
  createPostgresSyncProjectStore,
  createPostgresSyncRepository,
  migrateDatabase,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

const pool = createDatabasePool(databaseUrl);
const NOW = new Date("2026-09-19T09:00:00.000Z");

async function resetDatabaseSchemas() {
  await pool.query("drop schema if exists public cascade");
  await pool.query("drop schema if exists drizzle cascade");
  await pool.query("create schema public");
}

async function insertOwner() {
  const ownerId = randomUUID();
  await pool.query(
    `insert into owner_accounts
      (id, singleton_key, username, password_algorithm, password_salt, password_hash, password_parameters)
     values ($1, 1, $2, 'argon2id', 'salt', 'hash', '{}'::jsonb)`,
    [ownerId, `owner-${ownerId}`],
  );
  return ownerId;
}

function operation(
  deviceId: string,
  input: Omit<SyncOperation, "id" | "deviceId" | "createdAt">,
): SyncOperation {
  return {
    id: randomUUID(),
    deviceId,
    createdAt: NOW.toISOString(),
    ...input,
  };
}

async function createHarness() {
  const ownerId = await insertOwner();
  const repository = createPostgresSyncRepository(pool);
  const deviceId = randomUUID();
  await repository.registerDevice({
    id: deviceId,
    ownerId,
    name: "Integration browser",
    now: NOW,
  });

  const applier = createSyncOperationApplier({
    repository,
    projects: createPostgresSyncProjectStore(pool),
    documents: createPostgresSyncDocumentStore(pool),
    audit: createPostgresAuditRepository(pool),
    clock: { now: () => NOW },
    idGenerator: { next: () => randomUUID() },
  });

  return { ownerId, deviceId, repository, applier };
}

beforeEach(async () => {
  await resetDatabaseSchemas();
  await migrateDatabase(pool);
});

afterAll(async () => {
  await resetDatabaseSchemas();
  await closeDatabasePool(pool);
});

describe("Phase 2 sync apply persistence", () => {
  it("applies project mutations with monotonic CAS revisions and preserves stale input as a conflict", async () => {
    const { ownerId, deviceId, applier } = await createHarness();
    const projectId = randomUUID();

    const created = await applier.apply(
      ownerId,
      operation(deviceId, {
        projectId,
        entityType: "project",
        entityId: projectId,
        action: "project.create",
        baseRevision: null,
        payload: { name: "Offline project", description: null },
      }),
    );
    expect(created).toMatchObject({ kind: "upsert", revision: "1" });

    const updated = await applier.apply(
      ownerId,
      operation(deviceId, {
        projectId,
        entityType: "project",
        entityId: projectId,
        action: "project.update",
        baseRevision: "1",
        payload: { name: "Synced project" },
      }),
    );
    expect(updated).toMatchObject({ kind: "upsert", revision: "2" });

    const stale = await applier.apply(
      ownerId,
      operation(deviceId, {
        projectId,
        entityType: "project",
        entityId: projectId,
        action: "project.update",
        baseRevision: "1",
        payload: { name: "Stale project" },
      }),
    );

    expect(stale.kind).toBe("conflict");
    expect(stale.revision).toBe("2");
    expect(stale.payload).toMatchObject({
      incoming: { name: "Stale project" },
      current: { name: "Synced project" },
    });

    const row = await pool.query<{
      name: string;
      sync_revision: string;
      deleted_at: Date | null;
    }>(
      "select name, sync_revision::text, deleted_at from projects where id = $1",
      [projectId],
    );
    expect(row.rows[0]).toMatchObject({
      name: "Synced project",
      sync_revision: "2",
      deleted_at: null,
    });
  });

  it("preserves canonical note content when an offline update uses a stale revision", async () => {
    const { ownerId, deviceId, applier } = await createHarness();
    const projectId = randomUUID();
    await applier.apply(
      ownerId,
      operation(deviceId, {
        projectId,
        entityType: "project",
        entityId: projectId,
        action: "project.create",
        baseRevision: null,
        payload: { name: "Notes" },
      }),
    );

    const documentId = randomUUID();
    const created = await applier.apply(
      ownerId,
      operation(deviceId, {
        projectId,
        entityType: "document",
        entityId: documentId,
        action: "document.create",
        baseRevision: null,
        payload: { title: "Note", body: "first" },
      }),
    );
    expect(created.kind).toBe("upsert");
    expect(created.revision).toEqual(expect.any(String));

    const canonical = await applier.apply(
      ownerId,
      operation(deviceId, {
        projectId,
        entityType: "document",
        entityId: documentId,
        action: "document.update",
        baseRevision: created.revision,
        payload: { title: "Note", body: "server body" },
      }),
    );
    expect(canonical.kind).toBe("upsert");

    const stale = await applier.apply(
      ownerId,
      operation(deviceId, {
        projectId,
        entityType: "document",
        entityId: documentId,
        action: "document.update",
        baseRevision: created.revision,
        payload: { title: "Note", body: "offline body" },
      }),
    );

    expect(stale.kind).toBe("conflict");
    expect(stale.revision).toBe(canonical.revision);
    expect(stale.payload).toMatchObject({
      incoming: { title: "Note", body: "offline body" },
      current: { title: "Note", body: "server body" },
    });

    const current = await pool.query<{ body: string }>(
      `select r.content->>'body' as body
         from documents d
         join document_revisions r on r.id = d.current_revision_id
        where d.id = $1`,
      [documentId],
    );
    expect(current.rows[0]?.body).toBe("server body");
  });

  it("soft-deletes projects and rejects later offline resurrection attempts through the tombstone", async () => {
    const { ownerId, deviceId, applier } = await createHarness();
    const projectId = randomUUID();

    const created = await applier.apply(
      ownerId,
      operation(deviceId, {
        projectId,
        entityType: "project",
        entityId: projectId,
        action: "project.create",
        baseRevision: null,
        payload: { name: "Disposable" },
      }),
    );

    const deleted = await applier.apply(
      ownerId,
      operation(deviceId, {
        projectId,
        entityType: "project",
        entityId: projectId,
        action: "project.delete",
        baseRevision: created.revision,
        payload: {},
      }),
    );
    expect(deleted.kind).toBe("tombstone");

    const resurrection = await applier.apply(
      ownerId,
      operation(deviceId, {
        projectId,
        entityType: "project",
        entityId: projectId,
        action: "project.update",
        baseRevision: created.revision,
        payload: { name: "Resurrected" },
      }),
    );
    expect(resurrection.kind).toBe("conflict");
    expect(resurrection.payload).toMatchObject({
      incoming: { name: "Resurrected" },
      current: { deleted: true },
    });

    const row = await pool.query<{ deleted_at: Date | null }>(
      "select deleted_at from projects where id = $1",
      [projectId],
    );
    expect(row.rows[0]?.deleted_at).toBeInstanceOf(Date);
  });
});
