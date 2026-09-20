import { describe, expect, it, vi } from "vitest";
import type {
  ContextEnvelope,
  Execution,
  ExecutionReceipt,
  SanitizedExecutionError,
  StepExecutionStatus,
} from "@uw/contracts";
import type { Clock, IdGenerator } from "@uw/shared";
import { ToolRegistry, type ToolRunner } from "@uw/tools";
import {
  ExecutionFailure,
  createExecutionEngine,
  type EnqueueQueueJobInput,
  type ExecutionQueue,
  type ExecutionRepository,
  type ExecutionStepRecord,
  type ExecutionStepRepository,
  type ExecutionStepRuntimeLoader,
  type ExecutionReceiptRepository,
  type ExecutionOutputRecord,
  type ExecutionOutputRepository,
  type ExecutionStepLifecycle,
  type QueueJob,
} from "../src/index.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const STEP_ID = "44444444-4444-4444-8444-444444444444";
const JOB_ID = "55555555-5555-4555-8555-555555555555";
const RECEIPT_ID = "66666666-6666-4666-8666-666666666666";
const CONTEXT_ID = "77777777-7777-4777-8777-777777777777";
const NOW = new Date("2026-09-20T00:00:00.000Z");

class FixedClock implements Clock {
  now(): Date {
    return new Date(NOW);
  }
}

class FixedIds implements IdGenerator {
  next(): string {
    return RECEIPT_ID;
  }
}

class MemoryExecutions implements ExecutionRepository {
  constructor(readonly row: Execution) {}

  async create() {
    return structuredClone(this.row);
  }

  async getById(ownerId: string, executionId: string) {
    return this.row.ownerId === ownerId && this.row.id === executionId
      ? structuredClone(this.row)
      : null;
  }

  async getByIdForWorker(executionId: string) {
    return this.row.id === executionId ? structuredClone(this.row) : null;
  }

  async findByIdempotencyKey() {
    return null;
  }

  async transition(input: {
    ownerId: string;
    executionId: string;
    from: Execution["status"];
    to: Execution["status"];
    now: string;
    error?: SanitizedExecutionError | null;
  }) {
    if (
      this.row.ownerId !== input.ownerId ||
      this.row.id !== input.executionId ||
      this.row.status !== input.from
    ) {
      return null;
    }

    this.row.status = input.to;
    if (input.to === "running") this.row.startedAt ??= input.now;
    if (
      ["succeeded", "failed", "cancelled", "timed_out"].includes(input.to)
    ) {
      this.row.finishedAt = input.now;
    }
    if (input.error !== undefined) {
      if (input.error === null) delete this.row.error;
      else this.row.error = structuredClone(input.error);
    }
    return structuredClone(this.row);
  }

  async requestCancellation() {
    return structuredClone(this.row);
  }
}

class MemorySteps implements ExecutionStepRepository {
  constructor(
    readonly row: ExecutionStepRecord,
    readonly otherRows: ExecutionStepRecord[] = [],
  ) {}

  async create() {
    return structuredClone(this.row);
  }

  async listByExecution() {
    return [this.row, ...this.otherRows].map((row) => structuredClone(row));
  }

  async getById(stepExecutionId: string) {
    return this.row.id === stepExecutionId ? structuredClone(this.row) : null;
  }

  async transition(input: {
    stepExecutionId: string;
    from: StepExecutionStatus;
    to: StepExecutionStatus;
    now: string;
    attempt?: number;
    outputContextIds?: string[];
    error?: SanitizedExecutionError | null;
    usage?: { outputBytes: number; httpRequests: number };
  }) {
    if (
      this.row.id !== input.stepExecutionId ||
      this.row.status !== input.from
    ) {
      return null;
    }
    this.row.status = input.to;
    if (input.to === "running") this.row.startedAt ??= input.now;
    if (
      ["succeeded", "failed", "skipped", "cancelled", "timed_out"].includes(
        input.to,
      )
    ) {
      this.row.finishedAt = input.now;
    } else {
      this.row.finishedAt = null;
    }
    if (input.attempt !== undefined) this.row.attempt = input.attempt;
    if (input.outputContextIds) {
      this.row.outputContextIds = [...input.outputContextIds];
    }
    if (input.error !== undefined) this.row.error = input.error;
    if (input.usage) this.row.usage = structuredClone(input.usage);
    return structuredClone(this.row);
  }
}

class MemoryReceipts implements ExecutionReceiptRepository {
  readonly rows: ExecutionReceipt[] = [];

  async append(receipt: ExecutionReceipt) {
    if (receipt.stepExecutionId) {
      const existing = this.rows.find(
        (row) => row.stepExecutionId === receipt.stepExecutionId,
      );
      if (existing) return structuredClone(existing);
    }
    this.rows.push(structuredClone(receipt));
    return structuredClone(receipt);
  }

  async getByStep(stepExecutionId: string) {
    const receipt = this.rows.find(
      (row) => row.stepExecutionId === stepExecutionId,
    );
    return receipt ? structuredClone(receipt) : null;
  }

  async listByExecution(executionId: string) {
    return this.rows
      .filter((receipt) => receipt.executionId === executionId)
      .map((receipt) => structuredClone(receipt));
  }
}

class MemoryOutputs implements ExecutionOutputRepository {
  readonly rows: ExecutionOutputRecord[] = [];

  async appendMany(records: ExecutionOutputRecord[]) {
    this.rows.push(...records.map((record) => structuredClone(record)));
  }

  async listByStep(stepExecutionId: string) {
    return this.rows
      .filter((record) => record.stepExecutionId === stepExecutionId)
      .map((record) => structuredClone(record));
  }
}

class MemoryQueue implements ExecutionQueue {
  completed = 0;
  released: { availableAt: string; attempt: number } | null = null;
  abandoned = 0;

  async enqueue(input: EnqueueQueueJobInput) {
    return {
      ...structuredClone(input),
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: input.createdAt,
    };
  }

  async claim() {
    return null;
  }

  async complete() {
    this.completed += 1;
    return true;
  }

  async releaseForRetry(
    _jobId: string,
    _workerId: string,
    availableAt: string,
    attempt: number,
  ) {
    this.released = { availableAt, attempt };
    return true;
  }

  async abandon() {
    this.abandoned += 1;
    return true;
  }
}

function execution(overrides: Partial<Execution> = {}): Execution {
  return {
    id: EXECUTION_ID,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    kind: "tool",
    status: "queued",
    traceId: "88888888-8888-4888-8888-888888888888",
    idempotencyKey: "engine-test",
    budget: {
      maxWallClockMs: 60_000,
      maxSteps: 1,
      maxAttemptsPerStep: 3,
      maxTotalAttempts: 3,
      maxOutputBytes: 1_024,
      maxHttpRequests: 2,
    },
    queuedAt: NOW.toISOString(),
    ...overrides,
  };
}

function step(
  overrides: Partial<ExecutionStepRecord> = {},
): ExecutionStepRecord {
  return {
    id: STEP_ID,
    executionId: EXECUTION_ID,
    nodeId: "tool",
    toolId: "builtin.test.tool",
    toolVersion: "1",
    config: {},
    status: "queued",
    attempt: 0,
    inputContextIds: [],
    outputContextIds: [],
    startedAt: null,
    finishedAt: null,
    error: null,
    usage: { outputBytes: 0, httpRequests: 0 },
    ...overrides,
  };
}

function job(overrides: Partial<QueueJob> = {}): QueueJob {
  return {
    id: JOB_ID,
    executionId: EXECUTION_ID,
    stepExecutionId: STEP_ID,
    queueType: "step",
    attempt: 0,
    availableAt: NOW.toISOString(),
    leaseOwner: "worker-1",
    leaseExpiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function outputContext(): ContextEnvelope {
  return {
    id: CONTEXT_ID,
    type: "text",
    schemaVersion: 1,
    mimeType: "text/plain",
    metadata: {},
    payload: "ok",
    provenance: {
      projectId: PROJECT_ID,
      artifactIds: [],
      executionId: EXECUTION_ID,
      stepExecutionId: STEP_ID,
      parentContextIds: [],
    },
    capabilities: [],
  };
}

function registry(runner: ToolRunner, timeoutMs = 5_000) {
  const tools = new ToolRegistry();
  tools.register(
    {
      id: "builtin.test.tool",
      version: "1",
      displayName: "Test Tool",
      description: "Execution engine fixture",
      executionMode: "worker",
      accepts: [],
      produces: [{ name: "output", types: ["text"] }],
      configSchema: {},
      requiredCapabilities: [],
      defaults: { timeoutMs, maxAttempts: 3 },
    },
    runner,
  );
  return tools;
}

function setup(
  runner: ToolRunner,
  options: {
    execution?: Execution;
    step?: ExecutionStepRecord;
    timeoutMs?: number;
    lifecycle?: ExecutionStepLifecycle;
    otherSteps?: ExecutionStepRecord[];
  } = {},
) {
  const executions = new MemoryExecutions(options.execution ?? execution());
  const steps = new MemorySteps(
    options.step ?? step(),
    options.otherSteps ?? [],
  );
  const receipts = new MemoryReceipts();
  const outputs = new MemoryOutputs();
  const queue = new MemoryQueue();
  const runtime: ExecutionStepRuntimeLoader = {
    async load() {
      return { config: {}, inputs: {} };
    },
  };
  const engine = createExecutionEngine({
    executions,
    steps,
    receipts,
    outputs,
    queue,
    tools: registry(runner, options.timeoutMs),
    runtime,
    clock: new FixedClock(),
    idGenerator: new FixedIds(),
    retryRandom: () => 0.5,
    ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
  });
  return { engine, executions, steps, receipts, outputs, queue };
}

describe("ExecutionEngine", () => {
  it("transitions a tool step and execution to succeeded exactly once", async () => {
    const runner: ToolRunner = {
      run: vi.fn(async () => ({
        outputs: { output: outputContext() },
        usage: { outputBytes: 2, httpRequests: 0 },
      })),
    };
    const { engine, executions, steps, receipts, outputs, queue } = setup(runner);

    await engine.runClaimedJob(job(), "worker-1");

    expect(executions.row.status).toBe("succeeded");
    expect(steps.row.status).toBe("succeeded");
    expect(steps.row.attempt).toBe(1);
    expect(steps.row.outputContextIds).toEqual([CONTEXT_ID]);
    expect(outputs.rows).toHaveLength(1);
    expect(outputs.rows[0]?.contextId).toBe(CONTEXT_ID);
    expect(receipts.rows).toHaveLength(1);
    expect(receipts.rows[0]?.status).toBe("succeeded");
    expect(queue.completed).toBe(1);

    await engine.runClaimedJob(job(), "worker-1");
    expect(receipts.rows).toHaveLength(1);
  });

  it("reconciles persisted outputs for a reclaimed running step without replaying the tool", async () => {
    const runner: ToolRunner = {
      run: vi.fn(async () => {
        throw new Error("reclaimed step must not rerun the tool");
      }),
    };
    const runningStep = step({
      status: "running",
      attempt: 1,
      startedAt: NOW.toISOString(),
      usage: { outputBytes: 2, httpRequests: 0 },
    });
    const { engine, steps, outputs, receipts, queue } = setup(runner, {
      execution: execution({
        status: "running",
        startedAt: NOW.toISOString(),
      }),
      step: runningStep,
    });
    outputs.rows.push({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      executionId: EXECUTION_ID,
      stepExecutionId: STEP_ID,
      portName: "output",
      contextId: CONTEXT_ID,
      artifactId: null,
      context: outputContext(),
      createdAt: NOW.toISOString(),
    });

    await engine.runClaimedJob(job({ attempt: 1 }), "worker-1");

    expect(runner.run).not.toHaveBeenCalled();
    expect(steps.row.status).toBe("succeeded");
    expect(steps.row.outputContextIds).toEqual([CONTEXT_ID]);
    expect(receipts.rows[0]).toMatchObject({
      status: "succeeded",
      outputContextIds: [CONTEXT_ID],
      usage: { outputBytes: 2, httpRequests: 0 },
    });
    expect(queue.completed).toBe(1);
  });

  it("fails an ambiguous reclaimed running step instead of replaying side effects", async () => {
    const runner: ToolRunner = {
      run: vi.fn(async () => {
        throw new Error("ambiguous step must not rerun the tool");
      }),
    };
    const { engine, executions, steps, receipts, queue } = setup(runner, {
      execution: execution({
        status: "running",
        startedAt: NOW.toISOString(),
      }),
      step: step({
        status: "running",
        attempt: 1,
        startedAt: NOW.toISOString(),
      }),
    });

    await engine.runClaimedJob(job({ attempt: 1 }), "worker-1");

    expect(runner.run).not.toHaveBeenCalled();
    expect(executions.row.status).toBe("failed");
    expect(steps.row.status).toBe("failed");
    expect(receipts.rows[0]?.error).toMatchObject({
      code: "NETWORK_TRANSIENT",
      details: { reason: "AMBIGUOUS_WORKER_RECLAIM" },
    });
    expect(queue.completed).toBe(1);
  });

  it("replays terminal-step lifecycle before completing a reclaimed queue job", async () => {
    const runner: ToolRunner = {
      async run() {
        return {
          outputs: { output: outputContext() },
          usage: { outputBytes: 2, httpRequests: 0 },
        };
      },
    };
    let attempts = 0;
    const lifecycle: ExecutionStepLifecycle = {
      async onTerminalStep() {
        attempts += 1;
        if (attempts === 1) throw new Error("scheduler unavailable");
        return [];
      },
    };
    const { engine, steps, receipts, queue } = setup(runner, { lifecycle });

    await expect(
      engine.runClaimedJob(job(), "worker-1"),
    ).rejects.toThrow("scheduler unavailable");

    expect(steps.row.status).toBe("succeeded");
    expect(receipts.rows).toHaveLength(0);
    expect(queue.completed).toBe(0);

    await engine.runClaimedJob(job(), "worker-1");

    expect(attempts).toBe(2);
    expect(receipts.rows).toHaveLength(1);
    expect(queue.completed).toBe(1);
  });

  it("reconstructs a missing receipt when a terminal step job is reclaimed", async () => {
    const runner: ToolRunner = {
      run: vi.fn(async () => {
        throw new Error("terminal replay must not execute the tool");
      }),
    };
    const terminalStep = step({
      status: "succeeded",
      attempt: 1,
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
      outputContextIds: [CONTEXT_ID],
      usage: { outputBytes: 2, httpRequests: 0 },
    });
    const { engine, receipts, queue } = setup(runner, {
      execution: execution({
        status: "succeeded",
        startedAt: NOW.toISOString(),
        finishedAt: NOW.toISOString(),
      }),
      step: terminalStep,
    });

    await engine.runClaimedJob(job(), "worker-1");
    await engine.runClaimedJob(job(), "worker-1");

    expect(runner.run).not.toHaveBeenCalled();
    expect(receipts.rows).toHaveLength(1);
    expect(receipts.rows[0]).toMatchObject({
      executionId: EXECUTION_ID,
      stepExecutionId: STEP_ID,
      status: "succeeded",
      outputContextIds: [CONTEXT_ID],
    });
    expect(queue.completed).toBe(2);
  });

  it("records provenance ids returned by the terminal lifecycle in the receipt", async () => {
    const runner: ToolRunner = {
      async run() {
        return {
          outputs: { output: outputContext() },
          usage: { outputBytes: 2, httpRequests: 0 },
        };
      },
    };
    const provenanceId = "99999999-9999-4999-8999-999999999999";
    const lifecycle: ExecutionStepLifecycle = {
      async onTerminalStep() {
        return [provenanceId];
      },
    };
    const { engine, receipts } = setup(runner, { lifecycle });

    await engine.runClaimedJob(job(), "worker-1");

    expect(receipts.rows).toHaveLength(1);
    expect(receipts.rows[0]?.provenanceEdgeIds).toEqual([provenanceId]);
  });

  it("cancels before invoking the tool when cancellation was requested", async () => {
    const runner: ToolRunner = {
      run: vi.fn(async () => {
        throw new Error("must not run");
      }),
    };
    const { engine, executions, steps, receipts, queue } = setup(runner, {
      execution: execution({
        cancellationRequestedAt: NOW.toISOString(),
      }),
    });

    await engine.runClaimedJob(job(), "worker-1");

    expect(runner.run).not.toHaveBeenCalled();
    expect(executions.row.status).toBe("cancelled");
    expect(steps.row.status).toBe("cancelled");
    expect(receipts.rows[0]?.status).toBe("cancelled");
    expect(queue.completed).toBe(1);
  });

  it("releases retry-safe transient failures with a future attempt", async () => {
    const runner: ToolRunner = {
      async run() {
        throw new ExecutionFailure({
          code: "NETWORK_TRANSIENT",
          message: "temporary connection reset",
          method: "GET",
          retrySafe: true,
          ambiguous: false,
        });
      },
    };
    const { engine, executions, steps, receipts, queue } = setup(runner);

    await engine.runClaimedJob(job(), "worker-1");

    expect(executions.row.status).toBe("running");
    expect(steps.row.status).toBe("queued");
    expect(steps.row.attempt).toBe(1);
    expect(queue.released?.attempt).toBe(1);
    expect(queue.released?.availableAt).not.toBe(NOW.toISOString());
    expect(receipts.rows).toHaveLength(0);
  });

  it("times out a cancellable tool and writes one timed-out receipt", async () => {
    const runner: ToolRunner = {
      async run({ signal }) {
        await new Promise<never>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    };
    const { engine, executions, steps, receipts } = setup(runner, {
      timeoutMs: 10,
    });

    await engine.runClaimedJob(job(), "worker-1");

    expect(executions.row.status).toBe("timed_out");
    expect(steps.row.status).toBe("timed_out");
    expect(receipts.rows).toHaveLength(1);
    expect(receipts.rows[0]?.error?.code).toBe("TIMEOUT");
  });

  it("enforces maxTotalAttempts across all workflow steps", async () => {
    const runner: ToolRunner = {
      run: vi.fn(async () => ({
        outputs: { output: outputContext() },
        usage: { outputBytes: 2, httpRequests: 0 },
      })),
    };
    const previousStep = step({
      id: "88888888-8888-4888-8888-888888888888",
      nodeId: "previous",
      status: "succeeded",
      attempt: 2,
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
      usage: { outputBytes: 4, httpRequests: 0 },
    });
    const { engine, steps, receipts } = setup(runner, {
      execution: execution({
        kind: "workflow",
        workflowRevisionId: "99999999-9999-4999-8999-999999999999",
        budget: {
          maxWallClockMs: 60_000,
          maxSteps: 2,
          maxAttemptsPerStep: 3,
          maxTotalAttempts: 2,
          maxOutputBytes: 1_024,
          maxHttpRequests: 2,
        },
      }),
      otherSteps: [previousStep],
    });

    await engine.runClaimedJob(job(), "worker-1");

    expect(runner.run).not.toHaveBeenCalled();
    expect(steps.row.status).toBe("failed");
    expect(receipts.rows[0]?.error?.code).toBe("BUDGET_EXCEEDED");
    expect(receipts.rows[0]?.error?.details).toMatchObject({
      dimension: "totalAttempts",
      actual: 3,
      limit: 2,
    });
  });

  it("enforces output-byte budget cumulatively across workflow steps", async () => {
    const runner: ToolRunner = {
      async run() {
        return {
          outputs: { output: outputContext() },
          usage: { outputBytes: 200, httpRequests: 0 },
        };
      },
    };
    const previousStep = step({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      nodeId: "previous",
      status: "succeeded",
      attempt: 1,
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
      usage: { outputBytes: 900, httpRequests: 0 },
    });
    const { engine, steps, outputs, receipts } = setup(runner, {
      execution: execution({
        kind: "workflow",
        workflowRevisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        budget: {
          maxWallClockMs: 60_000,
          maxSteps: 2,
          maxAttemptsPerStep: 3,
          maxTotalAttempts: 4,
          maxOutputBytes: 1_000,
          maxHttpRequests: 2,
        },
      }),
      otherSteps: [previousStep],
    });

    await engine.runClaimedJob(job(), "worker-1");

    expect(steps.row.status).toBe("failed");
    expect(outputs.rows).toHaveLength(0);
    expect(receipts.rows[0]?.error?.code).toBe("BUDGET_EXCEEDED");
    expect(receipts.rows[0]?.error?.details).toMatchObject({
      dimension: "outputBytes",
      actual: 1_100,
      limit: 1_000,
    });
  });

  it("fails instead of persisting outputs that exceed the budget", async () => {
    const runner: ToolRunner = {
      async run() {
        return {
          outputs: { output: outputContext() },
          usage: { outputBytes: 2_048, httpRequests: 0 },
        };
      },
    };
    const { engine, executions, steps, receipts } = setup(runner);

    await engine.runClaimedJob(job(), "worker-1");

    expect(executions.row.status).toBe("failed");
    expect(steps.row.status).toBe("failed");
    expect(steps.row.outputContextIds).toEqual([]);
    expect(receipts.rows[0]?.error?.code).toBe("BUDGET_EXCEEDED");
  });
});
