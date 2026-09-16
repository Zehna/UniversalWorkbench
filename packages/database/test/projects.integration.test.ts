import { randomUUID } from "node:crypto";
import { createProjectService, ProjectNotFoundError } from "@uw/core";
import { SystemClock, UuidGenerator } from "@uw/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabasePool,
  createDatabasePool,
  createPostgresAuditRepository,
  createPostgresProjectRepository,
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

function createService() {
  return createProjectService({
    projects: createPostgresProjectRepository(pool),
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

describe("PostgreSQL project service", () => {
  it("creates, lists, reads and updates only the owner's project", async () => {
    const ownerId = await insertOwner();
    const service = createService();
    const createTraceId = randomUUID();
    const updateTraceId = randomUUID();

    const created = await service.create(
      ownerId,
      { name: "Historiography", description: "Primary source workspace" },
      createTraceId,
    );

    expect(created.ownerId).toBe(ownerId);
    expect(created.name).toBe("Historiography");
    expect(created.description).toBe("Primary source workspace");

    await expect(service.list(ownerId)).resolves.toEqual([created]);
    await expect(service.get(ownerId, created.id)).resolves.toEqual(created);

    const updated = await service.update(
      ownerId,
      created.id,
      { name: "Historiography Lab", description: null },
      updateTraceId,
    );

    expect(updated.name).toBe("Historiography Lab");
    expect(updated.description).toBeNull();
    expect(updated.updatedAt >= created.updatedAt).toBe(true);

    const audit = await pool.query<{
      action: string;
      project_id: string | null;
      trace_id: string;
      metadata: Record<string, unknown>;
    }>(
      `select action, project_id, trace_id, metadata
         from action_audit
        order by created_at, action`,
    );

    expect(audit.rows).toHaveLength(2);
    expect(audit.rows.map((row) => row.action).sort()).toEqual([
      "project.create",
      "project.update",
    ]);
    expect(audit.rows.map((row) => row.project_id)).toEqual([
      created.id,
      created.id,
    ]);
    expect(audit.rows.map((row) => row.trace_id).sort()).toEqual(
      [createTraceId, updateTraceId].sort(),
    );
    for (const row of audit.rows) {
      expect(row.metadata).not.toHaveProperty("description");
      expect(JSON.stringify(row.metadata)).not.toContain(
        "Primary source workspace",
      );
    }
  });

  it("does not expose a project to another actor id", async () => {
    const ownerId = await insertOwner();
    const otherActorId = randomUUID();
    const service = createService();
    const project = await service.create(
      ownerId,
      { name: "Private Project" },
      randomUUID(),
    );

    await expect(service.list(otherActorId)).resolves.toEqual([]);
    await expect(service.get(otherActorId, project.id)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
    await expect(
      service.update(
        otherActorId,
        project.id,
        { name: "Hijacked" },
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    await expect(service.get(ownerId, project.id)).resolves.toMatchObject({
      name: "Private Project",
    });
  });
});
