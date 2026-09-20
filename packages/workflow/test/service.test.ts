import { describe, expect, it, vi } from "vitest";
import type {
  Execution,
  ExecutionBudget,
  WorkflowDefinitionV1,
  WorkflowDocumentView,
} from "@uw/contracts";
import { ToolRegistry, type ToolRunner } from "@uw/tools";
import {
  createWorkflowService,
  type WorkflowExecutionEnqueuer,
  type WorkflowQueuePort,
  type WorkflowStepPort,
} from "../src/service.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const WORKFLOW_ID = "33333333-3333-4333-8333-333333333333";
const REVISION_ID = "44444444-4444-4444-8444-444444444444";
const EXECUTION_ID = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-09-20T00:00:00.000Z";

const budget: ExecutionBudget = {
  maxWallClockMs: 60_000,
  maxSteps: 10,
  maxAttemptsPerStep: 3,
  maxTotalAttempts: 10,
  maxOutputBytes: 1_048_576,
  maxHttpRequests: 5,
};

const runner: ToolRunner = {
  async run() {
    throw new Error("not used in workflow service tests");
  },
};

function registry() {
  const tools = new ToolRegistry();
  tools.register(
    {
      id: "builtin.fixture.root",
      version: "1",
      displayName: "Root",
      description: "Root fixture",
      executionMode: "worker",
      accepts: [],
      produces: [{ name: "output", types: ["json"] }],
      configSchema: {},
      requiredCapabilities: [],
      defaults: { timeoutMs: 1000, maxAttempts: 1 },
    },
    runner,
  );
  tools.register(
    {
      id: "builtin.fixture.child",
      version: "1",
      displayName: "Child v1",
      description: "Child fixture v1",
      executionMode: "worker",
      accepts: [{ name: "input", types: ["json"], required: true }],
      produces: [{ name: "output", types: ["text"] }],
      configSchema: {},
      requiredCapabilities: [],
      defaults: { timeoutMs: 1000, maxAttempts: 1 },
    },
    runner,
  );
  tools.register(
    {
      id: "builtin.fixture.child",
      version: "2",
      displayName: "Child v2",
      description: "Child fixture v2",
      executionMode: "worker",
      accepts: [{ name: "input", types: ["json"], required: true }],
      produces: [{ name: "output", types: ["text"] }],
      configSchema: {},
      requiredCapabilities: [],
      defaults: { timeoutMs: 1000, maxAttempts: 1 },
    },
    runner,
  );
  return tools;
}

function definition(): WorkflowDefinitionV1 {
  return {
    schemaVersion: 1,
    name: "Pinned workflow",
    nodes: [
      {
        id: "root",
        tool: { id: "builtin.fixture.root", version: "1" },
        config: { source: "fixture" },
      },
      {
        id: "child",
        tool: { id: "builtin.fixture.child", version: "1" },
        config: {},
      },
    ],
    edges: [
      {
        from: { nodeId: "root", output: "output" },
        to: { nodeId: "child", input: "input" },
      },
    ],
    outputs: [
      {
        name: "result",
        from: { nodeId: "child", output: "output" },
      },
    ],
  };
}

function canonicalView(): WorkflowDocumentView {
  return {
    document: {
      id: WORKFLOW_ID,
      projectId: PROJECT_ID,
      kind: "workflow",
      title: "Pinned workflow",
      currentRevisionId: REVISION_ID,
      createdAt: NOW,
      updatedAt: NOW,
    },
    revision: {
      id: REVISION_ID,
      documentId: WORKFLOW_ID,
      revisionNumber: 1,
      parentRevisionId: null,
      content: {
        kind: "workflow",
        workflow: definition(),
      },
      metadata: {},
      createdAt: NOW,
    },
  };
}

function execution(): Execution {
  return {
    id: EXECUTION_ID,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    kind: "workflow",
    workflowRevisionId: REVISION_ID,
    status: "queued",
    traceId: "66666666-6666-4666-8666-666666666666",
    idempotencyKey: "run-1",
    budget,
    queuedAt: NOW,
  };
}

function setup(options: { canonicalReject?: Error; existingSteps?: boolean } = {}) {
  const canonical = {
    assertCanonicalWorkflowRevision: vi.fn(async () => {
      if (options.canonicalReject) throw options.canonicalReject;
      return canonicalView();
    }),
  };

  const executions: WorkflowExecutionEnqueuer = {
    enqueueWorkflowExecution: vi.fn(async () => execution()),
  };

  const rows: Array<{
    id: string;
    nodeId: string;
    toolId: string;
    toolVersion: string;
    status: string;
  }> = options.existingSteps
    ? [
        {
          id: "77777777-7777-4777-8777-777777777777",
          nodeId: "root",
          toolId: "builtin.fixture.root",
          toolVersion: "1",
          status: "queued",
        },
      ]
    : [];

  let idIndex = options.existingSteps ? 1 : 0;
  const ids = [
    "77777777-7777-4777-8777-777777777777",
    "88888888-8888-4888-8888-888888888888",
    "99999999-9999-4999-8999-999999999999",
  ];

  const steps: WorkflowStepPort = {
    async listByExecution() {
      return rows as never;
    },
    async create(step) {
      rows.push({
        id: step.id,
        nodeId: step.nodeId,
        toolId: step.toolId,
        toolVersion: step.toolVersion,
        status: step.status,
      });
      return step;
    },
  };

  const queued: string[] = [];
  const queue: WorkflowQueuePort = {
    async enqueue(input) {
      queued.push(input.stepExecutionId ?? "");
      return {
        ...input,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: input.createdAt,
      };
    },
  };

  const service = createWorkflowService({
    canonical,
    executions,
    steps,
    queue,
    tools: registry(),
    allowedCapabilities: [],
    clock: { now: () => new Date(NOW) },
    idGenerator: {
      next() {
        return ids[idIndex++]!;
      },
    },
  });

  return { service, canonical, executions, rows, queued };
}

describe("WorkflowService", () => {
  it("rejects a non-canonical revision before enqueueing", async () => {
    const { service, executions } = setup({
      canonicalReject: new Error("revision is not canonical"),
    });

    await expect(
      service.enqueueRun({
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        workflowId: WORKFLOW_ID,
        workflowRevisionId: REVISION_ID,
        idempotencyKey: "run-1",
        budget,
      }),
    ).rejects.toThrow("revision is not canonical");

    expect(executions.enqueueWorkflowExecution).not.toHaveBeenCalled();
  });

  it("creates pinned step rows and queues only root nodes", async () => {
    const { service, rows, queued } = setup();

    const result = await service.enqueueRun({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
      workflowRevisionId: REVISION_ID,
      idempotencyKey: "run-1",
      budget,
    });

    expect(result.execution.id).toBe(EXECUTION_ID);
    expect(rows).toEqual([
      expect.objectContaining({
        nodeId: "root",
        toolId: "builtin.fixture.root",
        toolVersion: "1",
        status: "queued",
        config: { source: "fixture" },
      }),
      expect.objectContaining({
        nodeId: "child",
        toolId: "builtin.fixture.child",
        toolVersion: "1",
        status: "pending",
      }),
    ]);
    expect(queued).toEqual([rows[0]!.id]);
  });

  it("reconciles missing steps and root queue jobs after an interrupted enqueue", async () => {
    const { service, rows, queued } = setup({ existingSteps: true });

    await service.enqueueRun({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
      workflowRevisionId: REVISION_ID,
      idempotencyKey: "run-1",
      budget,
    });

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.nodeId === "child")).toMatchObject({
      toolId: "builtin.fixture.child",
      toolVersion: "1",
      status: "pending",
    });
    expect(queued).toEqual([
      "77777777-7777-4777-8777-777777777777",
    ]);
  });

  it("validates the exact pinned tool version, not the newest registered version", async () => {
    const { service, rows } = setup();

    await service.enqueueRun({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
      workflowRevisionId: REVISION_ID,
      idempotencyKey: "run-1",
      budget,
    });

    expect(rows.find((row) => row.nodeId === "child")?.toolVersion).toBe("1");
  });
});
