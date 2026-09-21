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

async function resetDatabaseSchemas() {
  await pool.query("drop schema if exists public cascade");
  await pool.query("drop schema if exists drizzle cascade");
  await pool.query("create schema public");
  await migrateDatabase(pool);
}

async function seedOwnerProjectExecution(
  input: {
    cancelled?: boolean;
    status?: "queued" | "running" | "cancelled";
  } = {},
) {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  const executionId = randomUUID();

  await pool.query(
    `insert into owner_accounts
      (id, singleton_key, username, password_algorithm, password_salt, password_hash, password_parameters)
     values ($1, 1, $2, 'argon2id', 'salt', 'hash', '{}'::jsonb)`,
    [ownerId, `owner-${ownerId}`],
  );
  await pool.query(
    `insert into projects (id, owner_id, name, description)
     values ($1, $2, 'Queue', null)`,
    [projectId, ownerId],
  );
  await pool.query(
    `insert into executions
      (
        id,
        owner_id,
        project_id,
        kind,
        status,
        trace_id,
        idempotency_key,
        budget,
        queued_at,
        cancellation_requested_at
      )
     values ($1, $2, $3, 'workflow', $4, $5, $6, '{}'::jsonb, $7, $8)`,
    [
      executionId,
      ownerId,
      projectId,
      input.status ?? "queued",
      randomUUID(),
      randomUUID(),
      "2026-09-20T00:00:00.000Z",
      input.cancelled ? "2026-09-20T00:00:01.000Z" : null,
    ],
  );

  return { ownerId, projectId, executionId };
}

async function seedJob(input: {
  executionId: string;
  stepExecutionId?: string | null;
  queueType?: "execution" | "step";
  attempt?: number;
  availableAt?: string;
}) {
  const id = randomUUID();
  await pool.query(
    `insert into execution_queue
      (
        id,
        execution_id,
        step_execution_id,
        queue_type,
        attempt,
        available_at,
        created_at,
        updated_at
      )
     values ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [
      id,
      input.executionId,
      input.stepExecutionId ?? null,
      input.queueType ?? "execution",
      input.attempt ?? 0,
      input.availableAt ?? "2026-09-20T00:00:00.000Z",
      "2026-09-20T00:00:00.000Z",
    ],
  );
  return id;
}

beforeEach(resetDatabaseSchemas);

afterAll(async () => {
  await resetDatabaseSchemas();
  await closeDatabasePool(pool);
});

describe("PostgreSQL execution queue", () => {
  it("lets only one concurrent worker claim a job", async () => {
    const { executionId } = await seedOwnerProjectExecution();
    const jobId = await seedJob({ executionId });
    const queue = createPostgresExecutionQueue(pool);

    const [left, right] = await Promise.all([
      queue.claim("worker-a", "2026-09-20T00:00:10.000Z", 30_000),
      queue.claim("worker-b", "2026-09-20T00:00:10.000Z", 30_000),
    ]);

    const claimed = [left, right].filter((job) => job !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(jobId);
  });

  it("does not claim a job before availableAt", async () => {
    const { executionId } = await seedOwnerProjectExecution();
    await seedJob({
      executionId,
      availableAt: "2026-09-20T00:01:00.000Z",
    });
    const queue = createPostgresExecutionQueue(pool);

    await expect(
      queue.claim("worker-a", "2026-09-20T00:00:30.000Z", 30_000),
    ).resolves.toBeNull();

    await expect(
      queue.claim("worker-a", "2026-09-20T00:01:01.000Z", 30_000),
    ).resolves.toMatchObject({
      executionId,
      leaseOwner: "worker-a",
    });
  });

  it("keeps an active lease exclusive and reclaims it after expiry", async () => {
    const { executionId } = await seedOwnerProjectExecution();
    const jobId = await seedJob({ executionId, attempt: 2 });
    const queue = createPostgresExecutionQueue(pool);

    const first = await queue.claim(
      "worker-a",
      "2026-09-20T00:00:10.000Z",
      30_000,
    );
    expect(first).toMatchObject({
      id: jobId,
      executionId,
      attempt: 2,
      leaseOwner: "worker-a",
    });

    await expect(
      queue.claim("worker-b", "2026-09-20T00:00:20.000Z", 30_000),
    ).resolves.toBeNull();

    const reclaimed = await queue.claim(
      "worker-b",
      "2026-09-20T00:00:41.000Z",
      30_000,
    );
    expect(reclaimed).toMatchObject({
      id: jobId,
      executionId,
      attempt: 2,
      leaseOwner: "worker-b",
    });
  });

  it("does not let the wrong worker complete another worker's lease", async () => {
    const { executionId } = await seedOwnerProjectExecution();
    const jobId = await seedJob({ executionId });
    const queue = createPostgresExecutionQueue(pool);

    await queue.claim("worker-a", "2026-09-20T00:00:10.000Z", 30_000);

    await expect(queue.complete(jobId, "worker-b")).resolves.toBe(false);
    await expect(queue.complete(jobId, "worker-a")).resolves.toBe(true);
    await expect(
      pool.query("select 1 from execution_queue where id = $1", [jobId]),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it("claims cancellation-requested work immediately so the worker can finalize it", async () => {
    const { executionId } = await seedOwnerProjectExecution({
      cancelled: true,
    });
    const jobId = await seedJob({
      executionId,
      availableAt: "2026-09-20T01:00:00.000Z",
    });
    const queue = createPostgresExecutionQueue(pool);

    await expect(
      queue.claim("worker-a", "2026-09-20T00:00:10.000Z", 30_000),
    ).resolves.toMatchObject({
      id: jobId,
      executionId,
      leaseOwner: "worker-a",
    });
  });

  it("drains leftover queue rows after an execution has become cancelled", async () => {
    const { executionId } = await seedOwnerProjectExecution({
      cancelled: true,
      status: "cancelled",
    });
    const jobId = await seedJob({
      executionId,
      availableAt: "2026-09-20T01:00:00.000Z",
    });
    const queue = createPostgresExecutionQueue(pool);

    await expect(
      queue.claim("worker-cleanup", "2026-09-20T00:00:10.000Z", 30_000),
    ).resolves.toMatchObject({
      id: jobId,
      executionId,
      leaseOwner: "worker-cleanup",
    });
  });

  it("releases a lease for retry with the same durable identity", async () => {
    const { executionId } = await seedOwnerProjectExecution();
    const jobId = await seedJob({ executionId });
    const queue = createPostgresExecutionQueue(pool);

    await queue.claim("worker-a", "2026-09-20T00:00:10.000Z", 30_000);
    await expect(
      queue.releaseForRetry(jobId, "worker-a", "2026-09-20T00:02:00.000Z", 1),
    ).resolves.toBe(true);

    await expect(
      queue.claim("worker-b", "2026-09-20T00:01:59.000Z", 30_000),
    ).resolves.toBeNull();

    await expect(
      queue.claim("worker-b", "2026-09-20T00:02:01.000Z", 30_000),
    ).resolves.toMatchObject({
      id: jobId,
      executionId,
      attempt: 1,
      leaseOwner: "worker-b",
    });
  });

  it("discards only unleased jobs during fail-fast cleanup", async () => {
    const { executionId } = await seedOwnerProjectExecution();
    const unleasedJobId = await seedJob({ executionId });
    const leasedJobId = await seedJob({ executionId });
    const queue = createPostgresExecutionQueue(pool);

    await expect(queue.discardUnleased(unleasedJobId)).resolves.toBe(true);
    await expect(
      pool.query("select 1 from execution_queue where id = $1", [unleasedJobId]),
    ).resolves.toMatchObject({ rowCount: 0 });

    await queue.claim("worker-a", "2026-09-20T00:00:10.000Z", 30_000);
    const leased = await pool.query<{ id: string }>(
      "select id from execution_queue where lease_owner = 'worker-a'",
    );
    expect(leased.rows[0]?.id).toBe(leasedJobId);
    await expect(queue.discardUnleased(leasedJobId)).resolves.toBe(false);
    await expect(
      pool.query("select 1 from execution_queue where id = $1", [leasedJobId]),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("abandons a lease without changing the job identity", async () => {
    const { executionId } = await seedOwnerProjectExecution();
    const jobId = await seedJob({ executionId });
    const queue = createPostgresExecutionQueue(pool);

    await queue.claim("worker-a", "2026-09-20T00:00:10.000Z", 30_000);
    await expect(queue.abandon(jobId, "worker-a")).resolves.toBe(true);

    await expect(
      queue.claim("worker-b", "2026-09-20T00:00:11.000Z", 30_000),
    ).resolves.toMatchObject({
      id: jobId,
      executionId,
      leaseOwner: "worker-b",
    });
  });
});
