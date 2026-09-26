import { randomUUID } from "node:crypto";
import type { ContextEnvelope } from "@uw/contracts";
import { ExecutionRepositoryError } from "@uw/execution";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabasePool,
  createDatabasePool,
  createPostgresExecutionRepository,
  migrateDatabase,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

const pool = createDatabasePool(databaseUrl);

async function resetDatabaseSchemas(): Promise<void> {
  await pool.query("drop schema if exists public cascade");
  await pool.query("drop schema if exists drizzle cascade");
  await pool.query("create schema public");
}

async function seedScope(): Promise<{
  ownerId: string;
  projectId: string;
  workflowDefinitionId: string;
}> {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  const workflowDefinitionId = randomUUID();
  await pool.query(
    `insert into owner_accounts
      (id, singleton_key, username, password_algorithm, password_salt, password_hash, password_parameters)
     values ($1, 1, $2, 'argon2id', 'salt', 'hash', '{}'::jsonb)`,
    [ownerId, "owner-" + ownerId],
  );
  await pool.query(
    "insert into projects (id, owner_id, name) values ($1, $2, 'Execution project')",
    [projectId, ownerId],
  );
  await pool.query(
    `insert into workflow_definitions
      (id, workflow_id, version, owner_id, project_id, name, schema_version, definition)
     values ($1,$2,1,$3,$4,'Execution workflow',1,$5::jsonb)`,
    [
      workflowDefinitionId,
      randomUUID(),
      ownerId,
      projectId,
      JSON.stringify({
        id: randomUUID(),
        projectId,
        name: "Execution workflow",
        schemaVersion: 1,
        nodes: [],
        edges: [],
      }),
    ],
  );
  return { ownerId, projectId, workflowDefinitionId };
}

function context(
  type: "json" | "text",
  payload: unknown,
  sourceContextIds: string[] = [],
): ContextEnvelope {
  return {
    id: randomUUID(),
    type,
    schemaVersion: 1,
    mimeType: type === "json" ? "application/json" : "text/plain",
    metadata: {},
    payload,
    provenance: { sourceContextIds },
    capabilities: [],
  };
}

beforeEach(async () => {
  await resetDatabaseSchemas();
  await migrateDatabase(pool);
});

afterAll(async () => {
  await resetDatabaseSchemas();
  await closeDatabasePool(pool);
});

describe("PostgreSQL execution repository", () => {
  it("persists a legal lifecycle, step provenance, usage and immutable receipt", async () => {
    const scope = await seedScope();
    const repository = createPostgresExecutionRepository(pool);
    const executionId = randomUUID();
    const inputContext = context("text", "  hello  ");
    const createdAt = new Date("2026-09-26T06:00:00.000Z");

    const created = await repository.createExecution({
      id: executionId,
      ...scope,
      traceId: randomUUID(),
      inputContext,
      createdAt,
    });
    expect(created).toMatchObject({
      id: executionId,
      ownerId: scope.ownerId,
      projectId: scope.projectId,
      workflowDefinitionId: scope.workflowDefinitionId,
      status: "queued",
      startedAt: null,
      finishedAt: null,
      error: null,
      usage: {},
    });

    const startedAt = new Date("2026-09-26T06:00:01.000Z");
    await repository.markRunning(executionId, startedAt);
    const output = context("text", "hello", [inputContext.id]);
    await repository.recordStep({
      id: randomUUID(),
      executionId,
      nodeId: randomUUID(),
      toolId: "builtin.text.trim",
      toolVersion: "1.0.0",
      attempt: 1,
      status: "completed",
      startedAt,
      finishedAt: new Date("2026-09-26T06:00:02.000Z"),
      inputContext,
      outputContexts: [output],
      error: null,
      idempotencyKey: null,
    });

    const finishedAt = new Date("2026-09-26T06:00:03.000Z");
    const usage = { inputBytes: 9, outputBytes: 5, toolCalls: 1 };
    const receipt = {
      executionId,
      status: "completed",
      outputContextIds: [output.id],
      checksum: "receipt-safe-value",
    };
    await repository.complete({ executionId, finishedAt, usage, receipt });

    const view = await repository.get(
      scope.ownerId,
      scope.projectId,
      executionId,
    );
    expect(view?.execution).toMatchObject({
      status: "completed",
      startedAt,
      finishedAt,
      usage,
      error: null,
    });
    expect(view?.steps).toHaveLength(1);
    expect(view?.steps[0]).toMatchObject({
      toolId: "builtin.text.trim",
      toolVersion: "1.0.0",
      attempt: 1,
      status: "completed",
      inputContext,
      outputContexts: [output],
    });
    expect(view?.provenanceEdges).toEqual([
      {
        fromContextId: inputContext.id,
        toContextId: output.id,
        nodeId: view?.steps[0]?.nodeId,
      },
    ]);
    expect(view?.receipt).toEqual(receipt);

    await expect(
      repository.complete({
        executionId,
        finishedAt: new Date("2026-09-26T06:00:04.000Z"),
        usage: {},
        receipt: { replacement: true },
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(
      (await repository.get(scope.ownerId, scope.projectId, executionId))
        ?.receipt,
    ).toEqual(receipt);
  });

  it("round-trips structured failure errors and usage without leaking through another owner id", async () => {
    const scope = await seedScope();
    const repository = createPostgresExecutionRepository(pool);
    const executionId = randomUUID();
    await repository.createExecution({
      id: executionId,
      ...scope,
      traceId: randomUUID(),
      inputContext: context("json", { query: "safe" }),
      createdAt: new Date("2026-09-26T07:00:00.000Z"),
    });
    await repository.markRunning(
      executionId,
      new Date("2026-09-26T07:00:01.000Z"),
    );
    const error = {
      code: "NETWORK_FAILURE",
      message: "Request failed safely",
      details: {
        retryable: false,
        upstreamStatus: 502,
        secretIncluded: false,
      },
    };
    const usage = { inputBytes: 42, outputBytes: 0, attempts: 1 };
    const receipt = {
      executionId,
      status: "failed",
      errorCode: error.code,
    };
    await repository.fail({
      executionId,
      finishedAt: new Date("2026-09-26T07:00:02.000Z"),
      error,
      usage,
      receipt,
    });

    const view = await repository.get(
      scope.ownerId,
      scope.projectId,
      executionId,
    );
    expect(view?.execution.error).toEqual(error);
    expect(view?.execution.usage).toEqual(usage);
    expect(view?.receipt).toEqual(receipt);

    await expect(
      repository.get(randomUUID(), scope.projectId, executionId),
    ).resolves.toBeNull();
    await expect(
      repository.get(scope.ownerId, randomUUID(), executionId),
    ).resolves.toBeNull();
  });

  it("conceals workflow scopes on create and rejects illegal state transitions", async () => {
    const scope = await seedScope();
    const repository = createPostgresExecutionRepository(pool);
    await expect(
      repository.createExecution({
        id: randomUUID(),
        ownerId: randomUUID(),
        projectId: scope.projectId,
        workflowDefinitionId: scope.workflowDefinitionId,
        traceId: randomUUID(),
        inputContext: context("json", {}),
        createdAt: new Date(),
      }),
    ).rejects.toBeInstanceOf(ExecutionRepositoryError);

    const executionId = randomUUID();
    await repository.createExecution({
      id: executionId,
      ...scope,
      traceId: randomUUID(),
      inputContext: context("json", {}),
      createdAt: new Date("2026-09-26T08:00:00.000Z"),
    });
    await expect(
      repository.complete({
        executionId,
        finishedAt: new Date(),
        usage: {},
        receipt: {},
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await repository.markRunning(
      executionId,
      new Date("2026-09-26T08:00:01.000Z"),
    );
    await expect(
      repository.markRunning(executionId, new Date()),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("persists deterministic cancellation receipts for queued executions", async () => {
    const scope = await seedScope();
    const repository = createPostgresExecutionRepository(pool);
    const executionId = randomUUID();
    await repository.createExecution({
      id: executionId,
      ...scope,
      traceId: randomUUID(),
      inputContext: context("json", {}),
      createdAt: new Date("2026-09-26T09:00:00.000Z"),
    });
    const finishedAt = new Date("2026-09-26T09:00:01.000Z");
    await repository.cancel(executionId, finishedAt);

    const view = await repository.get(
      scope.ownerId,
      scope.projectId,
      executionId,
    );
    expect(view?.execution.status).toBe("cancelled");
    expect(view?.execution.finishedAt).toEqual(finishedAt);
    expect(view?.receipt).toEqual({
      executionId,
      status: "cancelled",
      finishedAt: finishedAt.toISOString(),
    });
  });

  it("does not persist a step when the execution is not running", async () => {
    const scope = await seedScope();
    const repository = createPostgresExecutionRepository(pool);
    const executionId = randomUUID();
    const inputContext = context("text", "hello");
    await repository.createExecution({
      id: executionId,
      ...scope,
      traceId: randomUUID(),
      inputContext,
      createdAt: new Date(),
    });
    await expect(
      repository.recordStep({
        id: randomUUID(),
        executionId,
        nodeId: randomUUID(),
        toolId: "builtin.text.trim",
        toolVersion: "1.0.0",
        attempt: 1,
        status: "completed",
        startedAt: new Date(),
        finishedAt: new Date(),
        inputContext,
        outputContexts: [],
        error: null,
        idempotencyKey: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });

    const count = await pool.query<{ count: string }>(
      "select count(*)::text as count from execution_steps where execution_id = $1",
      [executionId],
    );
    expect(count.rows[0]?.count).toBe("0");
  });
});
