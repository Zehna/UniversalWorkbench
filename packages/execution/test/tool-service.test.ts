import { describe, expect, it, vi } from "vitest";
import type { Execution, JsonObject } from "@uw/contracts";
import { ToolRegistry, type ToolRunner } from "@uw/tools";
import {
  createDirectToolExecutionService,
  DirectToolCapabilityError,
  DirectToolConfigError,
  DirectToolExecutionConflictError,
  DirectToolInputRequiredError,
  type ExecutionQueue,
  type ExecutionService,
  type ExecutionStepRecord,
  type ExecutionStepRepository,
} from "../src/index.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const STEP_ID = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-09-20T00:00:00.000Z";

const runner: ToolRunner = {
  async run() {
    throw new Error("not used");
  },
};

function execution(status: Execution["status"] = "queued"): Execution {
  return {
    id: EXECUTION_ID,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    kind: "tool",
    status,
    traceId: "55555555-5555-4555-8555-555555555555",
    idempotencyKey: "direct-1",
    budget: {
      maxWallClockMs: 60_000,
      maxSteps: 10,
      maxAttemptsPerStep: 3,
      maxTotalAttempts: 10,
      maxOutputBytes: 1_048_576,
      maxHttpRequests: 5,
    },
    queuedAt: NOW,
  };
}

function registry(
  required = false,
  options: {
    configSchema?: JsonObject;
    requiredCapabilities?: ("network.public")[];
  } = {},
) {
  const tools = new ToolRegistry();
  tools.register(
    {
      id: "builtin.fixture.direct",
      version: "1",
      displayName: "Direct Fixture",
      description: "Direct fixture",
      executionMode: "worker",
      accepts: required
        ? [{ name: "input", types: ["json"], required: true }]
        : [{ name: "input", types: ["json"], required: false }],
      produces: [{ name: "output", types: ["json"] }],
      configSchema: options.configSchema ?? {},
      requiredCapabilities: options.requiredCapabilities ?? [],
      defaults: { timeoutMs: 1000, maxAttempts: 1 },
    },
    runner,
  );
  return tools;
}

function step(config: JsonObject): ExecutionStepRecord {
  return {
    id: STEP_ID,
    executionId: EXECUTION_ID,
    nodeId: "tool",
    toolId: "builtin.fixture.direct",
    toolVersion: "1",
    config,
    status: "queued",
    attempt: 0,
    inputContextIds: [],
    outputContextIds: [],
    startedAt: null,
    finishedAt: null,
    error: null,
    usage: { outputBytes: 0, httpRequests: 0 },
  };
}

function setup(
  existing: ExecutionStepRecord[] = [],
  options: {
    tools?: ToolRegistry;
    allowedCapabilities?: ("network.public")[];
  } = {},
) {
  const rows = existing.map((value) => structuredClone(value));
  const executions = {
    enqueueToolExecution: vi.fn(async () => execution()),
  } as unknown as Pick<ExecutionService, "enqueueToolExecution">;
  const steps = {
    async listByExecution() {
      return rows.map((value) => structuredClone(value));
    },
    async create(value: ExecutionStepRecord) {
      rows.push(structuredClone(value));
      return structuredClone(value);
    },
  } as Pick<ExecutionStepRepository, "listByExecution" | "create">;
  const queued: string[] = [];
  const queue = {
    async enqueue(input: Parameters<ExecutionQueue["enqueue"]>[0]) {
      queued.push(input.id);
      return {
        ...input,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: input.createdAt,
      };
    },
  } as Pick<ExecutionQueue, "enqueue">;

  const service = createDirectToolExecutionService({
    executions,
    steps,
    queue,
    tools: options.tools ?? registry(),
    allowedCapabilities: options.allowedCapabilities ?? [],
    clock: { now: () => new Date(NOW) },
    idGenerator: { next: () => STEP_ID },
  });

  return { service, executions, rows, queued };
}

describe("DirectToolExecutionService", () => {
  it("creates one durable queued step and queue job", async () => {
    const { service, executions, rows, queued } = setup();

    const result = await service.enqueueToolRun({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      idempotencyKey: "direct-1",
      tool: { id: "builtin.fixture.direct", version: "1" },
      config: { mode: "fixture" },
    });

    expect(executions.enqueueToolExecution).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      idempotencyKey: "direct-1",
    });
    expect(result.step).toMatchObject({
      id: STEP_ID,
      toolId: "builtin.fixture.direct",
      toolVersion: "1",
      config: { mode: "fixture" },
      status: "queued",
    });
    expect(rows).toHaveLength(1);
    expect(queued).toEqual([STEP_ID]);
  });

  it("replays the same step identity after an interrupted enqueue", async () => {
    const existing = step({ mode: "fixture" });
    const { service, rows, queued } = setup([existing]);

    const result = await service.enqueueToolRun({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      idempotencyKey: "direct-1",
      tool: { id: "builtin.fixture.direct", version: "1" },
      config: { mode: "fixture" },
    });

    expect(result.step.id).toBe(STEP_ID);
    expect(rows).toHaveLength(1);
    expect(queued).toEqual([STEP_ID]);
  });

  it("rejects idempotency-key reuse with different direct-tool config", async () => {
    const { service } = setup([step({ mode: "old" })]);

    await expect(
      service.enqueueToolRun({
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        idempotencyKey: "direct-1",
        tool: { id: "builtin.fixture.direct", version: "1" },
        config: { mode: "new" },
      }),
    ).rejects.toBeInstanceOf(DirectToolExecutionConflictError);
  });

  it("rejects invalid direct-tool configuration before enqueue", async () => {
    const tools = registry(false, {
      configSchema: {
        type: "object",
        required: ["mode"],
        additionalProperties: false,
        properties: { mode: { type: "string" } },
      },
    });
    const { service, executions } = setup([], { tools });

    await expect(
      service.enqueueToolRun({
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        idempotencyKey: "direct-1",
        tool: { id: "builtin.fixture.direct", version: "1" },
        config: { unexpected: true },
      }),
    ).rejects.toBeInstanceOf(DirectToolConfigError);
    expect(executions.enqueueToolExecution).not.toHaveBeenCalled();
  });

  it("rejects direct execution when required capabilities are unavailable", async () => {
    const tools = registry(false, {
      requiredCapabilities: ["network.public"],
    });
    const { service, executions } = setup([], {
      tools,
      allowedCapabilities: [],
    });

    await expect(
      service.enqueueToolRun({
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        idempotencyKey: "direct-1",
        tool: { id: "builtin.fixture.direct", version: "1" },
        config: {},
      }),
    ).rejects.toBeInstanceOf(DirectToolCapabilityError);
    expect(executions.enqueueToolExecution).not.toHaveBeenCalled();
  });

  it("rejects direct execution for a tool with required inputs", async () => {
    const executions = {
      enqueueToolExecution: vi.fn(),
    } as unknown as Pick<ExecutionService, "enqueueToolExecution">;
    const service = createDirectToolExecutionService({
      executions,
      steps: {
        listByExecution: vi.fn(),
        create: vi.fn(),
      },
      queue: { enqueue: vi.fn() },
      tools: registry(true),
      allowedCapabilities: [],
      clock: { now: () => new Date(NOW) },
      idGenerator: { next: () => STEP_ID },
    });

    await expect(
      service.enqueueToolRun({
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        idempotencyKey: "direct-1",
        tool: { id: "builtin.fixture.direct", version: "1" },
        config: {},
      }),
    ).rejects.toBeInstanceOf(DirectToolInputRequiredError);
    expect(executions.enqueueToolExecution).not.toHaveBeenCalled();
  });
});
