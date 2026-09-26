import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabasePool,
  createDatabasePool,
  createPostgresExecutionQueue,
  migrateDatabase,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const pool = createDatabasePool(databaseUrl);
let now = new Date("2026-09-26T12:00:00.000Z");

async function resetDatabase(): Promise<void> {
  await pool.query("drop schema if exists public cascade");
  await pool.query("drop schema if exists drizzle cascade");
  await pool.query("create schema public");
}

let scope: { ownerId: string; projectId: string } | null = null;

async function seedExecution(): Promise<string> {
  if (!scope) {
    const ownerId = randomUUID();
    const projectId = randomUUID();
    await pool.query(
      `insert into owner_accounts
         (id, singleton_key, username, password_algorithm, password_salt, password_hash, password_parameters)
       values ($1,1,$2,'argon2id','salt','hash','{}'::jsonb)`,
      [ownerId, "owner-" + ownerId],
    );
    await pool.query(
      "insert into projects (id, owner_id, name) values ($1,$2,'Queue test')",
      [projectId, ownerId],
    );
    scope = { ownerId, projectId };
  }

  const definitionId = randomUUID();
  const executionId = randomUUID();
  await pool.query(
    `insert into workflow_definitions
       (id, workflow_id, version, owner_id, project_id, name, schema_version, definition)
     values ($1,$2,1,$3,$4,'Queue workflow',1,'{}'::jsonb)`,
    [definitionId, randomUUID(), scope.ownerId, scope.projectId],
  );
  await pool.query(
    `insert into executions
       (id, owner_id, project_id, workflow_definition_id, status, trace_id, input_context)
     values ($1,$2,$3,$4,'queued',$5,'{}'::jsonb)`,
    [executionId, scope.ownerId, scope.projectId, definitionId, randomUUID()],
  );
  return executionId;
}

beforeEach(async () => {
  scope = null;
  now = new Date("2026-09-26T12:00:00.000Z");
  await resetDatabase();
  await migrateDatabase(pool);
});

afterAll(async () => {
  await resetDatabase();
  await closeDatabasePool(pool);
});

describe("PostgreSQL execution queue", () => {
  it("migrates queue storage and preserves FIFO among available rows", async () => {
    const queue = createPostgresExecutionQueue(pool, { now: () => now });
    const a = await seedExecution();
    const b = await seedExecution();
    const c = await seedExecution();
    await queue.enqueue(b, new Date(now.getTime() - 1000));
    await queue.enqueue(a, new Date(now.getTime() - 3000));
    await queue.enqueue(c, new Date(now.getTime() + 1000));

    const first = await queue.claim("worker-a", now, 3000);
    expect(first?.executionId).toBe(a);
    expect(first?.attempt).toBe(1);
    await queue.ack(first!);
    const second = await queue.claim("worker-b", now, 3000);
    expect(second?.executionId).toBe(b);
    await queue.ack(second!);
    expect(await queue.claim("worker-c", now, 3000)).toBeNull();

    now = new Date(now.getTime() + 1001);
    const third = await queue.claim("worker-c", now, 3000);
    expect(third?.executionId).toBe(c);
    await queue.ack(third!);
    const remaining = await pool.query(
      "select count(*)::int as count from execution_queue",
    );
    expect(remaining.rows[0]?.count).toBe(0);
  });

  it("claims rows once with concurrent workers and SKIP LOCKED", async () => {
    const queue = createPostgresExecutionQueue(pool, { now: () => now });
    const a = await seedExecution();
    const b = await seedExecution();
    await queue.enqueue(a, new Date(now.getTime() - 3000));
    await queue.enqueue(b, new Date(now.getTime() - 1000));
    const locked = await pool.connect();
    try {
      await locked.query("begin");
      await locked.query(
        "select execution_id from execution_queue where execution_id=$1 for update",
        [a],
      );
      const skipped = await queue.claim("other-worker", now, 5000);
      expect(skipped?.executionId).toBe(b);
      await locked.query("rollback");
      const [first, second] = await Promise.all([
        queue.claim("worker-1", now, 5000),
        queue.claim("worker-2", now, 5000),
      ]);
      expect([first?.executionId, second?.executionId].filter(Boolean)).toEqual(
        [a],
      );
      await queue.ack(skipped!);
      await queue.ack((first ?? second)!);
    } finally {
      await locked.query("rollback").catch(() => undefined);
      locked.release();
    }
  });

  it("fences stale ACK and release after lease expiry and reclaim", async () => {
    const queue = createPostgresExecutionQueue(pool, { now: () => now });
    const executionId = await seedExecution();
    await queue.enqueue(executionId, now);
    const original = await queue.claim("worker-old", now, 1000);
    expect(original).not.toBeNull();
    now = new Date(now.getTime() + 1001);
    await expect(queue.ack(original!)).rejects.toMatchObject({
      code: "LEASE_LOST",
    });
    const reclaimed = await queue.claim("worker-new", now, 1000);
    expect(reclaimed).toMatchObject({
      executionId,
      workerId: "worker-new",
      attempt: 2,
    });
    expect(reclaimed?.leaseToken).not.toBe(original?.leaseToken);
    await expect(queue.release(original!, now)).rejects.toMatchObject({
      code: "LEASE_LOST",
    });
    await queue.ack(reclaimed!);
  });

  it("delays released rows and preserves the attempt counter", async () => {
    const queue = createPostgresExecutionQueue(pool, { now: () => now });
    const executionId = await seedExecution();
    await queue.enqueue(executionId, now);
    const original = await queue.claim("worker-old", now, 3000);
    const readyAt = new Date(now.getTime() + 10_000);
    await queue.release(original!, readyAt);
    expect(await queue.claim("worker-early", now, 3000)).toBeNull();
    now = readyAt;
    const later = await queue.claim("worker-later", now, 3000);
    expect(later).toMatchObject({ executionId, attempt: 2 });
  });

  it("renews a valid token and rejects attempts to renew expired leases", async () => {
    const queue = createPostgresExecutionQueue(pool, { now: () => now });
    const executionId = await seedExecution();
    await queue.enqueue(executionId, now);
    const lease = await queue.claim("worker-1", now, 2000);
    now = new Date(now.getTime() + 1000);
    const extended = await queue.renew(lease!, now, 3000);
    expect(extended.leasedUntil).toEqual(new Date(now.getTime() + 3000));
    expect(extended.leaseToken).toBe(lease?.leaseToken);
    expect(extended.attempt).toBe(1);
    now = new Date(now.getTime() + 3001);
    await expect(queue.renew(extended, now, 2000)).rejects.toMatchObject({
      code: "LEASE_LOST",
    });
  });

  it("does not enqueue unknown or cancelled executions or reset duplicate leases", async () => {
    const queue = createPostgresExecutionQueue(pool, { now: () => now });
    await expect(queue.enqueue(randomUUID(), now)).rejects.toMatchObject({
      code: "NOT_QUEUED",
    });
    const executionId = await seedExecution();
    await queue.enqueue(executionId, now);
    const claimed = await queue.claim("worker-1", now, 3000);
    await queue.enqueue(executionId, new Date(now.getTime() - 5000));
    const row = await pool.query(
      "select lease_token, attempts from execution_queue where execution_id=$1",
      [executionId],
    );
    expect(row.rows[0]).toMatchObject({
      lease_token: claimed?.leaseToken,
      attempts: 1,
    });
    const cancelled = await seedExecution();
    await pool.query(
      "update executions set status='cancelled', finished_at=$2 where id=$1",
      [cancelled, now],
    );
    await expect(queue.enqueue(cancelled, now)).rejects.toMatchObject({
      code: "NOT_QUEUED",
    });
  });

  it("does not claim a terminal execution if its queue record survives cancellation", async () => {
    const queue = createPostgresExecutionQueue(pool, { now: () => now });
    const executionId = await seedExecution();
    await queue.enqueue(executionId, now);
    await pool.query(
      "update executions set status='cancelled', finished_at=$2 where id=$1",
      [executionId, now],
    );
    expect(await queue.claim("worker-1", now, 3000)).toBeNull();
  });
});
