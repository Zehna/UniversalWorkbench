import { describe, expect, it } from "vitest";
import type {
  ContextEnvelope,
  Execution,
  WorkflowDefinitionV1,
} from "@uw/contracts";
import type {
  ExecutionOutputRecord,
  ExecutionStepRecord,
} from "@uw/execution";
import { createExecutionRuntimeLoader } from "../src/worker-runtime.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const REVISION_ID = "44444444-4444-4444-8444-444444444444";
const ROOT_STEP_ID = "55555555-5555-4555-8555-555555555555";
const CHILD_STEP_ID = "66666666-6666-4666-8666-666666666666";
const CONTEXT_ID = "77777777-7777-4777-8777-777777777777";
const NOW = "2026-09-20T00:00:00.000Z";

function workflow(): WorkflowDefinitionV1 {
  return {
    schemaVersion: 1,
    name: "Loader fixture",
    nodes: [
      {
        id: "root",
        tool: { id: "builtin.root", version: "1" },
        config: { source: "root" },
      },
      {
        id: "child",
        tool: { id: "builtin.child", version: "1" },
        config: { target: "child" },
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

function execution(kind: Execution["kind"] = "workflow"): Execution {
  return {
    id: EXECUTION_ID,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    kind,
    ...(kind === "workflow" ? { workflowRevisionId: REVISION_ID } : {}),
    status: "running",
    traceId: "88888888-8888-4888-8888-888888888888",
    idempotencyKey: "loader-1",
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
  config: Record<string, string>,
): ExecutionStepRecord {
  return {
    id,
    executionId: EXECUTION_ID,
    nodeId,
    toolId: `builtin.${nodeId}`,
    toolVersion: "1",
    config,
    status,
    attempt: status === "succeeded" ? 1 : 0,
    inputContextIds: [],
    outputContextIds: status === "succeeded" ? [CONTEXT_ID] : [],
    startedAt: status === "succeeded" ? NOW : null,
    finishedAt: status === "succeeded" ? NOW : null,
    error: null,
    usage: { outputBytes: 0, httpRequests: 0 },
  };
}

function context(): ContextEnvelope {
  return {
    id: CONTEXT_ID,
    type: "json",
    schemaVersion: 1,
    mimeType: "application/json",
    metadata: {},
    payload: { ok: true },
    provenance: {
      projectId: PROJECT_ID,
      artifactIds: [],
      executionId: EXECUTION_ID,
      stepExecutionId: ROOT_STEP_ID,
      parentContextIds: [],
    },
    capabilities: [],
  };
}

describe("execution runtime loader", () => {
  it("loads persisted direct-tool config with no implicit inputs", async () => {
    const loader = createExecutionRuntimeLoader({
      workflows: {
        async loadPinnedRevision() {
          throw new Error("direct tool must not load a workflow");
        },
      },
      steps: {
        async listByExecution() {
          return [];
        },
      },
      outputs: {
        async listByStep() {
          return [];
        },
      },
    });

    const loaded = await loader.load(
      execution("tool"),
      step(CHILD_STEP_ID, "tool", "queued", { url: "https://example.com" }),
    );

    expect(loaded).toEqual({
      config: { url: "https://example.com" },
      inputs: {},
    });
  });

  it("reconstructs workflow input ports from durable upstream outputs", async () => {
    const root = step(ROOT_STEP_ID, "root", "succeeded", { source: "root" });
    const child = step(CHILD_STEP_ID, "child", "queued", { target: "child" });
    const output: ExecutionOutputRecord = {
      id: "99999999-9999-4999-8999-999999999999",
      executionId: EXECUTION_ID,
      stepExecutionId: ROOT_STEP_ID,
      portName: "output",
      contextId: CONTEXT_ID,
      artifactId: null,
      context: context(),
      createdAt: NOW,
    };
    const loader = createExecutionRuntimeLoader({
      workflows: {
        async loadPinnedRevision(input) {
          expect(input.workflowRevisionId).toBe(REVISION_ID);
          return workflow();
        },
      },
      steps: {
        async listByExecution() {
          return [root, child];
        },
      },
      outputs: {
        async listByStep(stepExecutionId) {
          return stepExecutionId === ROOT_STEP_ID ? [output] : [];
        },
      },
    });

    const loaded = await loader.load(execution(), child);

    expect(loaded.config).toEqual({ target: "child" });
    expect(loaded.inputs).toEqual({ input: context() });
  });

  it("fails closed when an upstream output referenced by the workflow is missing", async () => {
    const root = step(ROOT_STEP_ID, "root", "succeeded", { source: "root" });
    const child = step(CHILD_STEP_ID, "child", "queued", { target: "child" });
    const loader = createExecutionRuntimeLoader({
      workflows: {
        async loadPinnedRevision() {
          return workflow();
        },
      },
      steps: {
        async listByExecution() {
          return [root, child];
        },
      },
      outputs: {
        async listByStep() {
          return [];
        },
      },
    });

    await expect(loader.load(execution(), child)).rejects.toThrow(
      "Workflow output root.output is missing",
    );
  });
});
