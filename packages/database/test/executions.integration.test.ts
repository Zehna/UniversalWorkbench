import { randomUUID } from "node:crypto";
import type {
  Execution,
  ExecutionReceipt,
} from "@uw/contracts";
import type { ProvenanceEdge } from "@uw/execution";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabasePool,
  createDatabasePool,
  createPostgresExecutionReceiptRepository,
  createPostgresExecutionRepository,
  createPostgresProvenanceRepository,
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
     values ($1, $2, 'Executions', null)`,
    [projectId, ownerId],
  );
  return { ownerId, projectId };
}

function execution(
  ownerId: string,
  projectId: string,
  input: Partial<Execution> = {},
): Execution {
  return {
    id: randomUUID(),
    ownerId,
    projectId,
    kind: "workflow",
    workflowRevisionId: undefined,
    status: "queued",
    traceId: randomUUID(),
    idempotencyKey: "same-key",
    budget: {
      maxWallClockMs: 60_000,
      maxSteps: 10,
      maxAttemptsPerStep: 3,
      maxTotalAttempts: 20,
      maxOutputBytes: 1024 * 1024,
      maxHttpRequests: 10,
    },
    queuedAt: "2026-09-20T00:00:00.000Z",
    ...input,
  };
}

beforeEach(resetDatabaseSchemas);

afterAll(async () => {
  await resetDatabaseSchemas();
  await closeDatabasePool(pool);
});

describe("PostgreSQL execution repositories", () => {
  it("creates once and returns the original execution for the same idempotency scope", async () => {
    const { ownerId, projectId } = await seedOwnerProject();
    const repository = createPostgresExecutionRepository(pool);
    const firstInput = execution(ownerId, projectId);

    const first = await repository.create({ execution: firstInput });
    const duplicate = await repository.create({
      execution: execution(ownerId, projectId, {
        idempotencyKey: firstInput.idempotencyKey,
      }),
    });

    expect(duplicate.id).toBe(first.id);

    const count = await pool.query<{ count: string }>(
      `select count(*)::text as count
         from executions
        where owner_id = $1
          and project_id = $2
          and kind = 'workflow'
          and idempotency_key = $3`,
      [ownerId, projectId, firstInput.idempotencyKey],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("allows another project to reuse the same idempotency key", async () => {
    const { ownerId, projectId } = await seedOwnerProject();
    const otherProjectId = randomUUID();
    await pool.query(
      `insert into projects (id, owner_id, name, description)
       values ($1, $2, 'Other', null)`,
      [otherProjectId, ownerId],
    );

    const repository = createPostgresExecutionRepository(pool);
    const first = await repository.create({
      execution: execution(ownerId, projectId),
    });
    const second = await repository.create({
      execution: execution(ownerId, otherProjectId),
    });

    expect(second.id).not.toBe(first.id);
  });

  it("does not add a cancellation request to a terminal execution", async () => {
    const { ownerId, projectId } = await seedOwnerProject();
    const repository = createPostgresExecutionRepository(pool);
    const created = await repository.create({
      execution: execution(ownerId, projectId, {
        status: "succeeded",
        finishedAt: "2026-09-20T00:01:00.000Z",
      }),
    });

    const result = await repository.requestCancellation({
      ownerId,
      executionId: created.id,
      now: "2026-09-20T00:02:00.000Z",
    });

    expect(result?.status).toBe("succeeded");
    expect(result?.cancellationRequestedAt).toBeUndefined();
  });

  it("appends and reads immutable receipts", async () => {
    const { ownerId, projectId } = await seedOwnerProject();
    const executions = createPostgresExecutionRepository(pool);
    const receipts = createPostgresExecutionReceiptRepository(pool);
    const created = await executions.create({
      execution: execution(ownerId, projectId),
    });

    const receipt: ExecutionReceipt = {
      id: randomUUID(),
      executionId: created.id,
      stepExecutionId: null,
      workflowRevisionId: null,
      tool: null,
      inputContextIds: [],
      outputContextIds: [],
      capabilities: [],
      attemptCount: 1,
      startedAt: "2026-09-20T00:00:00.000Z",
      finishedAt: "2026-09-20T00:00:01.000Z",
      status: "succeeded",
      error: null,
      usage: { outputBytes: 0, httpRequests: 0 },
      provenanceEdgeIds: [],
    };

    await receipts.append(receipt);
    await expect(receipts.listByExecution(created.id)).resolves.toEqual([
      receipt,
    ]);
  });

  it("appends and reads provenance edges without mutation methods", async () => {
    const { ownerId, projectId } = await seedOwnerProject();
    const executions = createPostgresExecutionRepository(pool);
    const provenance = createPostgresProvenanceRepository(pool);
    const created = await executions.create({
      execution: execution(ownerId, projectId),
    });

    const edge: ProvenanceEdge = {
      id: randomUUID(),
      projectId,
      executionId: created.id,
      stepExecutionId: null,
      sourceKind: "context",
      sourceId: randomUUID(),
      targetKind: "artifact",
      targetId: randomUUID(),
      relation: "produced",
      createdAt: "2026-09-20T00:00:01.000Z",
    };

    await provenance.append(edge);
    await expect(provenance.listByExecution(created.id)).resolves.toEqual([
      edge,
    ]);
  });
});
