import { describe, expect, it } from "vitest";
import type {
  ContextEnvelope,
  Execution,
  WorkflowDefinitionV1,
} from "@uw/contracts";
import type {
  ExecutionOutputRecord,
  ExecutionOutputRepository,
  ExecutionQueue,
  ExecutionRepository,
  ExecutionStepRecord,
  ExecutionStepRepository,
  ProvenanceEdge,
  ProvenanceRepository,
} from "@uw/execution";
import { createWorkflowExecutionLifecycle } from "../src/execution-lifecycle.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const REVISION_ID = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-09-20T00:00:00.000Z";

function workflow(): WorkflowDefinitionV1 {
  return {
    schemaVersion: 1,
    name: "Branched",
    nodes: [
      { id: "a", tool: { id: "builtin.a", version: "1" }, config: {} },
      { id: "b", tool: { id: "builtin.b", version: "1" }, config: {} },
      { id: "join", tool: { id: "builtin.join", version: "1" }, config: {} },
    ],
    edges: [
      {
        from: { nodeId: "a", output: "output" },
        to: { nodeId: "join", input: "left" },
      },
      {
        from: { nodeId: "b", output: "output" },
        to: { nodeId: "join", input: "right" },
      },
    ],
    outputs: [{ name: "result", from: { nodeId: "join", output: "output" } }],
  };
}

function execution(status: Execution["status"] = "running"): Execution {
  return {
    id: EXECUTION_ID,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    kind: "workflow",
    workflowRevisionId: REVISION_ID,
    status,
    traceId: "55555555-5555-4555-8555-555555555555",
    idempotencyKey: "workflow-run",
    budget: {
      maxWallClockMs: 60_000,
      maxSteps: 10,
      maxAttemptsPerStep: 3,
      maxTotalAttempts: 10,
      maxOutputBytes: 1_048_576,
      maxHttpRequests: 5,
    },
    queuedAt: NOW,
    startedAt: NOW,
  };
}

function step(
  id: string,
  nodeId: string,
  status: ExecutionStepRecord["status"],
): ExecutionStepRecord {
  return {
    id,
    executionId: EXECUTION_ID,
    nodeId,
    toolId: `builtin.${nodeId}`,
    toolVersion: "1",
    status,
    attempt: status === "pending" ? 0 : 1,
    inputContextIds: [],
    outputContextIds: [],
    startedAt: status === "pending" ? null : NOW,
    finishedAt:
      status === "succeeded" || status === "failed" ? NOW : null,
    error:
      status === "failed"
        ? { code: "TOOL_BUG", message: "failed" }
        : null,
    usage: { outputBytes: 0, httpRequests: 0 },
  };
}

function context(id: string, parentContextIds: string[] = []): ContextEnvelope {
  return {
    id,
    type: "json",
    schemaVersion: 1,
    mimeType: "application/json",
    metadata: {},
    payload: { id },
    provenance: {
      projectId: PROJECT_ID,
      artifactIds: [],
      executionId: EXECUTION_ID,
      parentContextIds,
    },
    capabilities: [],
  };
}

class MemorySteps implements ExecutionStepRepository {
  constructor(readonly rows: ExecutionStepRecord[]) {}

  async create(record: ExecutionStepRecord) {
    this.rows.push(structuredClone(record));
    return structuredClone(record);
  }

  async listByExecution(executionId: string) {
    return this.rows
      .filter((row) => row.executionId === executionId)
      .map((row) => structuredClone(row));
  }

  async getById(id: string) {
    const row = this.rows.find((candidate) => candidate.id === id);
    return row ? structuredClone(row) : null;
  }

  async transition(input: Parameters<ExecutionStepRepository["transition"]>[0]) {
    const row = this.rows.find(
      (candidate) =>
        candidate.id === input.stepExecutionId &&
        candidate.status === input.from,
    );
    if (!row) return null;
    row.status = input.to;
    if (input.inputContextIds) row.inputContextIds = [...input.inputContextIds];
    if (input.outputContextIds) {
      row.outputContextIds = [...input.outputContextIds];
    }
    if (input.error !== undefined) row.error = input.error;
    if (input.usage) row.usage = structuredClone(input.usage);
    if (input.attempt !== undefined) row.attempt = input.attempt;
    if (
      ["succeeded", "failed", "skipped", "cancelled", "timed_out"].includes(
        input.to,
      )
    ) {
      row.finishedAt = input.now;
    }
    return structuredClone(row);
  }
}

class MemoryOutputs implements ExecutionOutputRepository {
  constructor(readonly rows: ExecutionOutputRecord[]) {}

  async appendMany(records: ExecutionOutputRecord[]) {
    this.rows.push(...records.map((record) => structuredClone(record)));
  }

  async listByStep(stepExecutionId: string) {
    return this.rows
      .filter((row) => row.stepExecutionId === stepExecutionId)
      .map((row) => structuredClone(row));
  }
}

class MemoryExecutions implements ExecutionRepository {
  constructor(readonly row: Execution) {}

  async create() {
    return structuredClone(this.row);
  }
  async getById() {
    return structuredClone(this.row);
  }
  async getByIdForWorker() {
    return structuredClone(this.row);
  }
  async findByIdempotencyKey() {
    return null;
  }
  async requestCancellation() {
    return structuredClone(this.row);
  }
  async transition(input: Parameters<ExecutionRepository["transition"]>[0]) {
    if (this.row.status !== input.from) return null;
    this.row.status = input.to;
    if (input.error !== undefined) {
      if (input.error === null) delete this.row.error;
      else this.row.error = input.error;
    }
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(input.to)) {
      this.row.finishedAt = input.now;
    }
    return structuredClone(this.row);
  }
}

class MemoryQueue implements ExecutionQueue {
  readonly jobs = new Map<string, string>();

  async enqueue(input: Parameters<ExecutionQueue["enqueue"]>[0]) {
    this.jobs.set(input.id, input.stepExecutionId ?? "");
    return {
      ...input,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: input.createdAt,
    };
  }
  async claim() {
    return null;
  }
  async complete() {
    return true;
  }
  async releaseForRetry() {
    return true;
  }
  async abandon() {
    return true;
  }
}

class MemoryProvenance implements ProvenanceRepository {
  readonly rows: ProvenanceEdge[] = [];
  async append(edge: ProvenanceEdge) {
    if (!this.rows.some((row) => row.id === edge.id)) {
      this.rows.push(structuredClone(edge));
    }
  }
  async listByExecution(executionId: string) {
    return this.rows.filter((row) => row.executionId === executionId);
  }
}

function output(
  id: string,
  stepExecutionId: string,
  portName: string,
  parentContextIds: string[] = [],
): ExecutionOutputRecord {
  return {
    id: `f${id.slice(1)}`,
    executionId: EXECUTION_ID,
    stepExecutionId,
    portName,
    contextId: id,
    artifactId: null,
    context: context(id, parentContextIds),
    createdAt: NOW,
  };
}

function setup(input: {
  a: ExecutionStepRecord["status"];
  b: ExecutionStepRecord["status"];
  join?: ExecutionStepRecord["status"];
}) {
  const a = step("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "a", input.a);
  const b = step("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "b", input.b);
  const join = step(
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "join",
    input.join ?? "pending",
  );
  const steps = new MemorySteps([a, b, join]);
  const outputs = new MemoryOutputs([
    ...(input.a === "succeeded"
      ? [output("dddddddd-dddd-4ddd-8ddd-dddddddddddd", a.id, "output")]
      : []),
    ...(input.b === "succeeded"
      ? [output("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", b.id, "output")]
      : []),
  ]);
  const executions = new MemoryExecutions(execution());
  const queue = new MemoryQueue();
  const provenance = new MemoryProvenance();
  let edgeIndex = 0;
  const edgeIds = [
    "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  ];

  const lifecycle = createWorkflowExecutionLifecycle({
    workflows: {
      async loadPinnedRevision() {
        return workflow();
      },
    },
    executions,
    steps,
    outputs,
    queue,
    provenance,
    clock: { now: () => new Date(NOW) },
    edgeIds: {
      next() {
        return edgeIds[edgeIndex++]!;
      },
    },
  });

  return { lifecycle, executions, steps, outputs, queue, provenance, a, b, join };
}

describe("workflow execution lifecycle", () => {
  it("waits for all dependencies before queueing a join node", async () => {
    const { lifecycle, queue, join, a } = setup({
      a: "succeeded",
      b: "running",
    });

    await lifecycle.onTerminalStep({ execution: execution(), step: a });

    expect((await queue.jobs.size)).toBe(0);
    expect((await lifecycle.inspect(EXECUTION_ID)).find((x) => x.id === join.id))
      .toMatchObject({ status: "pending" });
  });

  it("queues a ready node with exact upstream context ids and replays safely", async () => {
    const { lifecycle, queue, join, b } = setup({
      a: "succeeded",
      b: "succeeded",
    });

    await lifecycle.onTerminalStep({ execution: execution(), step: b });
    await lifecycle.onTerminalStep({ execution: execution(), step: b });

    const queued = (await lifecycle.inspect(EXECUTION_ID)).find(
      (item) => item.id === join.id,
    );
    expect(queued).toMatchObject({
      status: "queued",
      inputContextIds: [
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      ],
    });
    expect([...queue.jobs.entries()]).toEqual([[join.id, join.id]]);
  });

  it("skips descendants and fails the workflow after a terminal step failure", async () => {
    const { lifecycle, executions, join, a } = setup({
      a: "failed",
      b: "succeeded",
    });

    await lifecycle.onTerminalStep({ execution: execution(), step: a });

    expect((await lifecycle.inspect(EXECUTION_ID)).find((x) => x.id === join.id))
      .toMatchObject({ status: "skipped" });
    expect(executions.row.status).toBe("failed");
  });

  it("skips unrelated pending work after fail-fast while allowing running work to settle", async () => {
    const { lifecycle, executions, steps, a } = setup({
      a: "failed",
      b: "running",
      join: "pending",
    });
    const unrelated = step(
      "abababab-abab-4bab-8bab-abababababab",
      "unrelated",
      "pending",
    );
    steps.rows.push(unrelated);

    await lifecycle.onTerminalStep({ execution: execution(), step: a });

    expect(steps.rows.find((item) => item.id === unrelated.id)?.status).toBe(
      "skipped",
    );
    expect(executions.row.status).toBe("running");
  });

  it("writes provenance from parent contexts to successful outputs only once", async () => {
    const { lifecycle, provenance, join, steps, outputs } = setup({
      a: "succeeded",
      b: "succeeded",
      join: "succeeded",
    });
    join.inputContextIds = [
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    ];
    join.outputContextIds = ["99999999-9999-4999-8999-999999999999"];
    outputs.rows.push(
      output(
        "99999999-9999-4999-8999-999999999999",
        join.id,
        "output",
        join.inputContextIds,
      ),
    );
    const storedJoin = steps.rows.find((item) => item.id === join.id)!;
    storedJoin.inputContextIds = [...join.inputContextIds];
    storedJoin.outputContextIds = [...join.outputContextIds];

    const firstIds = await lifecycle.onTerminalStep({
      execution: execution(),
      step: storedJoin,
    });
    const replayIds = await lifecycle.onTerminalStep({
      execution: execution(),
      step: storedJoin,
    });

    expect(firstIds).toHaveLength(2);
    expect(replayIds).toEqual(firstIds);
    expect(provenance.rows).toHaveLength(2);
    expect(provenance.rows.map((edge) => edge.sourceId)).toEqual(
      join.inputContextIds,
    );
    expect(provenance.rows.every((edge) => edge.targetId === join.outputContextIds[0]))
      .toBe(true);
  });
});
