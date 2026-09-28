import { randomUUID } from "node:crypto";
import type { WorkflowDefinition } from "@uw/contracts";
import {
  WorkflowNotFoundError,
  WorkflowVersionConflictError,
} from "@uw/workflow";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabasePool,
  createDatabasePool,
  createPostgresWorkflowRepository,
  migrateDatabase,
} from "../src/index.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const pool = createDatabasePool(url);

async function reset() {
  await pool.query("drop schema if exists public cascade");
  await pool.query("drop schema if exists drizzle cascade");
  await pool.query("create schema public");
}

async function seed() {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  await pool.query(
    `insert into owner_accounts
      (id, singleton_key, username, password_algorithm, password_salt, password_hash, password_parameters)
     values ($1,1,$2,'argon2id','salt','hash','{}'::jsonb)`,
    [ownerId, "owner-" + ownerId],
  );
  await pool.query(
    "insert into projects (id, owner_id, name) values ($1,$2,'First'),($3,$2,'Second')",
    [projectId, ownerId, otherProjectId],
  );
  return { ownerId, projectId, otherProjectId };
}

function definition(projectId: string): WorkflowDefinition {
  return {
    id: randomUUID(),
    projectId,
    name: "Draft",
    schemaVersion: 1,
    nodes: [],
    edges: [],
  };
}

beforeEach(async () => {
  await reset();
  await migrateDatabase(pool);
});
afterAll(async () => {
  await reset();
  await closeDatabasePool(pool);
});

describe("immutable owner-scoped workflow versions", () => {
  it("creates and lists versions, preserving old definitions and execution history", async () => {
    const { ownerId, projectId } = await seed();
    const repo = createPostgresWorkflowRepository(pool);
    const draft = definition(projectId);
    const first = await repo.save(ownerId, projectId, draft);
    expect(first).toMatchObject({
      workflowId: draft.id,
      version: 1,
      ownerId,
      projectId,
      definition: draft,
    });
    const same = await repo.save(ownerId, projectId, structuredClone(draft));
    expect(same.id).toBe(first.id);
    const revised = { ...draft, name: "Published" };
    const second = await repo.save(ownerId, projectId, revised, 1);
    expect(second.version).toBe(2);
    expect(second.id).not.toBe(first.id);
    expect((await repo.list(ownerId, projectId)).map((x) => x.version)).toEqual(
      [2],
    );
    expect((await repo.get(ownerId, projectId, draft.id))?.definition).toEqual(
      revised,
    );
    const persisted = await pool.query<{
      id: string;
      version: number;
      definition: WorkflowDefinition;
    }>(
      "select id,version,definition from workflow_definitions where workflow_id=$1 order by version",
      [draft.id],
    );
    expect(persisted.rows.map((x) => x.version)).toEqual([1, 2]);
    expect(persisted.rows[0]?.definition).toEqual(draft);
    await expect(
      pool.query(
        "update workflow_definitions set name='overwrite' where id=$1",
        [first.id],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("conceals workflows across project and owner boundaries", async () => {
    const { ownerId, projectId, otherProjectId } = await seed();
    const repo = createPostgresWorkflowRepository(pool);
    const draft = definition(projectId);
    await repo.save(ownerId, projectId, draft);
    expect(await repo.list(ownerId, otherProjectId)).toEqual([]);
    expect(await repo.get(ownerId, otherProjectId, draft.id)).toBeNull();
    expect(await repo.get(randomUUID(), projectId, draft.id)).toBeNull();
    await expect(repo.list(randomUUID(), projectId)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
    await expect(
      repo.save(ownerId, otherProjectId, {
        ...draft,
        projectId: otherProjectId,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(
      repo.save(randomUUID(), projectId, draft),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it("rejects stale writes and serializes competing updates without overwriting", async () => {
    const { ownerId, projectId } = await seed();
    const repo = createPostgresWorkflowRepository(pool);
    const draft = definition(projectId);
    await repo.save(ownerId, projectId, draft);
    await expect(
      repo.save(ownerId, projectId, { ...draft, name: "Changed" }),
    ).rejects.toBeInstanceOf(WorkflowVersionConflictError);
    const competing = await Promise.allSettled([
      repo.save(ownerId, projectId, { ...draft, name: "First edit" }, 1),
      repo.save(ownerId, projectId, { ...draft, name: "Second edit" }, 1),
    ]);
    expect(competing.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(competing.filter((x) => x.status === "rejected")).toHaveLength(1);
    const versions = await pool.query<{ count: number }>(
      "select count(*)::int as count from workflow_definitions where workflow_id=$1",
      [draft.id],
    );
    expect(versions.rows[0]?.count).toBe(2);
  });

  it("rejects a deleted project even when its definition is still stored", async () => {
    const { ownerId, projectId } = await seed();
    const repo = createPostgresWorkflowRepository(pool);
    const draft = definition(projectId);
    await repo.save(ownerId, projectId, draft);
    await pool.query("update projects set deleted_at=now() where id=$1", [
      projectId,
    ]);
    await expect(repo.list(ownerId, projectId)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
    await expect(repo.get(ownerId, projectId, draft.id)).resolves.toBeNull();
  });
});
