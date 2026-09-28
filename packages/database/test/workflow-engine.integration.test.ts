import { randomUUID } from "node:crypto";
import type { ContextEnvelope, WorkflowDefinition } from "@uw/contracts";
import { createWorkflowEngine } from "@uw/execution";
import { createToolRegistry, createTextTrimTool } from "@uw/tools";
import { validateWorkflow } from "@uw/workflow";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabasePool,
  createDatabasePool,
  createPostgresExecutionQueue,
  createPostgresWorkflowExecutionStore,
  migrateDatabase,
} from "../src/index.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const pool = createDatabasePool(url);
const permissions = new Set<string>();
const budget = { maxSteps: 3, maxDurationMs: 30_000, maxOutputBytes: 200_000 };

async function reset(): Promise<void> {
  await pool.query("drop schema if exists public cascade");
  await pool.query("drop schema if exists drizzle cascade");
  await pool.query("create schema public");
}

async function seedScope(): Promise<{ ownerId: string; projectId: string }> {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  await pool.query(
    `insert into owner_accounts
       (id, singleton_key, username, password_algorithm, password_salt, password_hash,
        password_parameters)
     values ($1, 1, $2, 'argon2id', 'salt', 'hash', '{}'::jsonb)`,
    [ownerId, "owner-" + ownerId],
  );
  await pool.query(
    "insert into projects (id, owner_id, name) values ($1, $2, 'Engine test')",
    [projectId, ownerId],
  );
  return { ownerId, projectId };
}

function definition(projectId: string): WorkflowDefinition {
  return {
    id: randomUUID(),
    projectId,
    name: "Persistent text trim",
    schemaVersion: 1,
    nodes: [
      {
        id: randomUUID(),
        toolId: "builtin.text.trim",
        toolVersion: "1.0.0",
        config: {},
        input: { source: "workflow_input" },
      },
    ],
    edges: [],
  };
}

function rootContext(): ContextEnvelope {
  return {
    id: randomUUID(),
    type: "text",
    schemaVersion: 1,
    mimeType: "text/plain",
    metadata: {},
    payload: "  durable  ",
    provenance: { sourceContextIds: [] },
    capabilities: [],
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

describe("PostgreSQL engine submission and execution", () => {
  it("atomically persists a versioned definition, request and ready queue item", async () => {
    const { ownerId, projectId } = await seedScope();
    const registry = createToolRegistry();
    registry.register(createTextTrimTool());
    const store = createPostgresWorkflowExecutionStore(pool);
    const engine = createWorkflowEngine({ store, registry });
    const graph = definition(projectId);
    const input = rootContext();
    const created = await engine.enqueue({
      ownerId,
      projectId,
      workflow: validateWorkflow(graph, registry),
      input,
      permissions,
      budget,
      traceId: randomUUID(),
    });

    expect(created.status).toBe("queued");
    const saved = await store.load(created.id);
    expect(saved?.workflow).toEqual(graph);
    expect(saved?.grantedPermissions).toEqual([]);
    expect(saved?.budget).toEqual(budget);
    const ready = await pool.query(
      "select execution_id from execution_queue where execution_id = $1",
      [created.id],
    );
    expect(ready.rowCount).toBe(1);
    const queue = createPostgresExecutionQueue(pool);
    const lease = await queue.claim(
      "worker-test",
      new Date(Date.now() + 60_000),
      120_000,
    );
    expect(lease?.executionId).toBe(created.id);

    const result = await engine.process(
      created.id,
      new AbortController().signal,
    );
    expect(result.execution.status).toBe("completed");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.outputContexts[0]?.payload).toBe("durable");
    expect(result.provenanceEdges).toEqual([
      {
        fromContextId: input.id,
        toContextId: result.steps[0]?.outputContexts[0]?.id,
        nodeId: graph.nodes[0]?.id,
      },
    ]);
    expect(result.receipt).toMatchObject({
      workflowId: graph.id,
      workflowVersion: 1,
      status: "completed",
    });

    await queue.ack(lease!);
    const reopened = createPostgresWorkflowExecutionStore(pool);
    const replay = createWorkflowEngine({ store: reopened, registry });
    const replayed = await replay.process(
      created.id,
      new AbortController().signal,
    );
    expect(replayed.steps).toHaveLength(1);
    expect(replayed.execution.status).toBe("completed");
    expect(await reopened.get(randomUUID(), projectId, created.id)).toBeNull();
  });

  it("reuses an immutable matching version but rejects changes without a version bump", async () => {
    const { ownerId, projectId } = await seedScope();
    const registry = createToolRegistry();
    registry.register(createTextTrimTool());
    const store = createPostgresWorkflowExecutionStore(pool);
    const engine = createWorkflowEngine({ store, registry });
    const graph = definition(projectId);
    const common = {
      ownerId,
      projectId,
      permissions,
      budget,
      workflow: validateWorkflow(graph, registry),
    };
    const first = await engine.enqueue({
      ...common,
      input: rootContext(),
      traceId: randomUUID(),
    });
    const second = await engine.enqueue({
      ...common,
      input: rootContext(),
      traceId: randomUUID(),
    });
    expect(second.workflowDefinitionId).toBe(first.workflowDefinitionId);
    expect(
      (await pool.query("select count(*)::int as n from workflow_definitions"))
        .rows[0]?.n,
    ).toBe(1);

    const changed = { ...graph, name: "Changed without version bump" };
    await expect(
      engine.enqueue({
        ...common,
        workflow: validateWorkflow(changed, registry),
        input: rootContext(),
        traceId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_VERSION_CONFLICT" });
    expect(
      (await pool.query("select count(*)::int as n from executions")).rows[0]
        ?.n,
    ).toBe(2);
    expect(
      (await pool.query("select count(*)::int as n from execution_requests"))
        .rows[0]?.n,
    ).toBe(2);
    expect(
      (await pool.query("select count(*)::int as n from execution_queue"))
        .rows[0]?.n,
    ).toBe(2);
  });

  it("does not enqueue into a different owner/project scope", async () => {
    const { projectId } = await seedScope();
    const registry = createToolRegistry();
    registry.register(createTextTrimTool());
    const engine = createWorkflowEngine({
      store: createPostgresWorkflowExecutionStore(pool),
      registry,
    });
    await expect(
      engine.enqueue({
        ownerId: randomUUID(),
        projectId,
        workflow: validateWorkflow(definition(projectId), registry),
        input: rootContext(),
        permissions,
        budget,
        traceId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_SCOPE_MISMATCH" });
    const count = await pool.query<{ n: number }>(
      "select count(*)::int as n from execution_queue",
    );
    expect(count.rows[0]?.n).toBe(0);
  });
});
