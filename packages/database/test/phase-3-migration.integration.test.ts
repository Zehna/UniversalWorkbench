import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabasePool,
  createDatabasePool,
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

async function seedOwnerProject() {
  const ownerId = randomUUID();
  const projectId = randomUUID();

  await pool.query(
    `insert into owner_accounts
      (id, singleton_key, username, password_algorithm, password_salt, password_hash, password_parameters)
     values ($1, 1, $2, 'argon2id', 'salt', 'hash', '{}'::jsonb)`,
    [ownerId, `owner-${ownerId}`],
  );
  await pool.query(
    `insert into projects (id, owner_id, name, description)
     values ($1, $2, 'Phase 3', null)`,
    [projectId, ownerId],
  );

  return { ownerId, projectId };
}

beforeEach(async () => {
  await resetDatabaseSchemas();
  await migrateDatabase(pool);
});

afterAll(async () => {
  await resetDatabaseSchemas();
  await closeDatabasePool(pool);
});

describe("Phase 3 execution persistence migration", () => {
  it("creates all durable execution tables", async () => {
    const result = await pool.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public'
          and table_name = any($1::text[])
        order by table_name`,
      [[
        "execution_outputs",
        "execution_queue",
        "execution_receipts",
        "execution_steps",
        "executions",
        "provenance_edges",
      ]],
    );

    expect(result.rows.map((row) => row.table_name)).toEqual([
      "execution_outputs",
      "execution_queue",
      "execution_receipts",
      "execution_steps",
      "executions",
      "provenance_edges",
    ]);
  });

  it("enforces execution and step lifecycle statuses in PostgreSQL", async () => {
    const { ownerId, projectId } = await seedOwnerProject();

    await expect(
      pool.query(
        `insert into executions
          (id, owner_id, project_id, kind, status, trace_id, idempotency_key, budget, queued_at)
         values ($1, $2, $3, 'tool', 'invalid', $4, 'bad-status', '{}'::jsonb, now())`,
        [randomUUID(), ownerId, projectId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    const executionId = randomUUID();
    await pool.query(
      `insert into executions
        (id, owner_id, project_id, kind, status, trace_id, idempotency_key, budget, queued_at)
       values ($1, $2, $3, 'workflow', 'queued', $4, 'step-status', '{}'::jsonb, now())`,
      [executionId, ownerId, projectId, randomUUID()],
    );

    await expect(
      pool.query(
        `insert into execution_steps
          (id, execution_id, node_id, tool_id, tool_version, status, attempt)
         values ($1, $2, 'root', 'builtin.json.select', '1', 'invalid', 0)`,
        [randomUUID(), executionId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("deduplicates execution creation by owner project kind and idempotency key", async () => {
    const { ownerId, projectId } = await seedOwnerProject();
    const insert = () =>
      pool.query(
        `insert into executions
          (id, owner_id, project_id, kind, status, trace_id, idempotency_key, budget, queued_at)
         values ($1, $2, $3, 'workflow', 'queued', $4, 'same-key', '{}'::jsonb, now())`,
        [randomUUID(), ownerId, projectId, randomUUID()],
      );

    await insert();
    await expect(insert()).rejects.toMatchObject({ code: "23505" });
  });

  it("creates queue indexes for availability and lease recovery", async () => {
    const result = await pool.query<{ indexname: string }>(
      `select indexname
         from pg_indexes
        where schemaname = 'public'
          and tablename = 'execution_queue'`,
    );
    const names = result.rows.map((row) => row.indexname);

    expect(names).toContain("execution_queue_available_idx");
    expect(names).toContain("execution_queue_lease_expiry_idx");
  });

  it("applies the Phase 3 migration idempotently", async () => {
    await expect(migrateDatabase(pool)).resolves.toBeUndefined();
  });
});
