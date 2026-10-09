import { randomUUID } from "node:crypto";
import type { ContextEnvelope, WorkflowDefinition } from "@uw/contracts";
import type { AuthService } from "@uw/auth";
import type { DocumentService } from "@uw/documents";
import type { CreateNoteRequest } from "@uw/contracts";
import type {
  ExecutionView,
  FinishStepInput,
  StoredWorkflowRun,
  WorkflowExecutionStore,
} from "@uw/execution";
import type { ExecutionSubmission } from "@uw/execution";
import type { ExecutionRecord, ExecutionStepRecord } from "@uw/execution";
import {
  createAgentTool,
  createJsonExtractTool,
  createTextTrimTool,
  createToolRegistry,
} from "@uw/tools";
import { createWorkflowEngine } from "@uw/execution";
import { validateWorkflow } from "@uw/workflow";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { composeToolRegistry } from "../src/composition.js";
import { resolveSecretResource } from "../src/secrets/resolve.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const WORKFLOW = "33333333-3333-4333-8333-333333333333";
const EXECUTION = "44444444-4444-4444-8444-444444444444";
const NODE = "55555555-5555-4555-8555-555555555555";
const OUTPUT = "66666666-6666-4666-8666-666666666666";
const VAULT_SECRET = "vault-plaintext-canary-7f3a9c";
const cookie = "uw_session=valid";

const AI_FLAGS = [
  "WORKBENCH_AI_MOCK",
  "WORKBENCH_E2E_FIXTURE",
  "WORKBENCH_DOCKER_SMOKE_FIXTURE",
] as const;

afterEach(() => {
  for (const flag of AI_FLAGS) delete process.env[flag];
});

function withAiMock(): void {
  process.env.WORKBENCH_AI_MOCK = "1";
}

function textInput(payload = "hello"): ContextEnvelope {
  return {
    id: randomUUID(),
    type: "text",
    schemaVersion: 1,
    mimeType: "text/plain",
    metadata: {},
    payload,
    provenance: { sourceContextIds: [] },
    capabilities: [],
  };
}

function agentResponseOutput(
  text = "agent final answer",
  trace: unknown[] = [{ iteration: 1, thought: "reasoning step" }],
): ContextEnvelope {
  return {
    id: OUTPUT,
    type: "agent_response",
    schemaVersion: 1,
    mimeType: "application/json",
    metadata: {},
    payload: {
      text,
      model: "mock-model",
      status: "completed",
      iterations: 1,
      trace,
      usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
      usageSource: "provider",
    },
    provenance: { sourceContextIds: [] },
    capabilities: [],
  };
}

function agentGraph(
  secretRef = "secret://vault/openai",
  providerId = "mock",
): WorkflowDefinition {
  return {
    id: WORKFLOW,
    projectId: PROJECT,
    name: "Agent workflow",
    schemaVersion: 1,
    nodes: [
      {
        id: NODE,
        toolId: "builtin.ai.agent",
        toolVersion: "1.0.0",
        config: {
          providerId,
          model: "mock-model",
          prompt: "Answer:",
          secretRef,
          allowedTools: [],
          maxIterations: 2,
        },
        input: { source: "workflow_input" },
      },
    ],
    edges: [],
  };
}

function authService(): AuthService {
  return {
    resolveSession: vi.fn(async () => ({
      id: OWNER,
      username: "owner",
      createdAt: new Date().toISOString(),
    })),
  } as unknown as AuthService;
}

function sessionCookie() {
  return { name: "uw_session", secure: false, maxAgeSeconds: 604800 };
}

class FakeStore implements WorkflowExecutionStore {
  readonly runs = new Map<string, StoredWorkflowRun>();
  async submit(input: ExecutionSubmission): Promise<ExecutionRecord> {
    const execution: ExecutionRecord = {
      id: input.id,
      ownerId: input.ownerId,
      projectId: input.projectId,
      workflowDefinitionId: input.workflowDefinitionId,
      status: "queued",
      traceId: input.traceId,
      inputContext: input.inputContext,
      startedAt: null,
      finishedAt: null,
      error: null,
      usage: {},
      createdAt: input.createdAt,
    };
    this.runs.set(input.id, {
      view: { execution, steps: [], provenanceEdges: [], receipt: null },
      workflow: input.workflow,
      workflowVersion: input.workflowVersion,
      grantedPermissions: input.grantedPermissions,
      budget: input.budget,
    });
    return execution;
  }
  async load(id: string): Promise<StoredWorkflowRun | null> {
    return this.runs.get(id) ?? null;
  }
  async createExecution(): Promise<ExecutionRecord> {
    throw new Error("Use atomic submit");
  }
  async get(owner: string, project: string, id: string) {
    const row = this.runs.get(id);
    return row &&
      row.view.execution.ownerId === owner &&
      row.view.execution.projectId === project
      ? row.view
      : null;
  }
  async markRunning(id: string, startedAt: Date): Promise<void> {
    const row = this.runs.get(id)!;
    row.view.execution.status = "running";
    row.view.execution.startedAt = startedAt;
  }
  async suspendExecution(id: string, usage: Record<string, unknown>): Promise<void> {
    const row = this.runs.get(id)!;
    row.view.execution.status = "awaiting_approval";
    row.view.execution.usage = usage;
  }
  async resumeExecution(id: string): Promise<void> {
    const row = this.runs.get(id)!;
    row.view.execution.status = "running";
  }
  async suspend(input: { executionId: string; usage: Record<string, unknown> }): Promise<void> {
    return this.suspendExecution(input.executionId, input.usage);
  }
  async resume(id: string): Promise<void> {
    return this.resumeExecution(id);
  }
  async startStep(step: ExecutionStepRecord): Promise<void> {
    this.runs.get(step.executionId)!.view.steps.push({ ...step });
  }
  async finishStep(input: FinishStepInput): Promise<void> {
    const row = this.runs.get(input.executionId)!;
    const step = row.view.steps.find((s) => s.id === input.id)!;
    step.status = input.status;
    step.finishedAt = input.finishedAt;
    step.outputContexts = input.outputContexts;
    step.error = input.error;
  }
  async recordStep(step: ExecutionStepRecord): Promise<void> {
    this.runs.get(step.executionId)!.view.steps.push(step);
  }
  async complete(input: {
    executionId: string;
    finishedAt: Date;
    usage: Record<string, unknown>;
    receipt: Record<string, unknown>;
  }): Promise<void> {
    const view = this.runs.get(input.executionId)!.view;
    view.execution.status = "completed";
    view.execution.finishedAt = input.finishedAt;
    view.execution.usage = input.usage;
    view.receipt = input.receipt;
  }
  async fail(input: {
    executionId: string;
    finishedAt: Date;
    usage: Record<string, unknown>;
    receipt: Record<string, unknown>;
    error: {
      code: string;
      message: string;
      details: Record<string, unknown> | null;
    };
  }): Promise<void> {
    const view = this.runs.get(input.executionId)!.view;
    view.execution.status = "failed";
    view.execution.finishedAt = input.finishedAt;
    view.execution.usage = input.usage;
    view.execution.error = input.error;
    view.receipt = input.receipt;
  }
  async cancel(id: string, finishedAt: Date): Promise<void> {
    const view = this.runs.get(id)!.view;
    view.execution.status = "cancelled";
    view.execution.finishedAt = finishedAt;
  }
}

function fakeVault(values: Record<string, string> = {}) {
  return {
    put: vi.fn(),
    get: vi.fn(async (_owner: string, name: string) => values[name] ?? null),
    remove: vi.fn(),
    list: vi.fn(async () => Object.keys(values)),
  };
}

function agentProviderDouble(
  text = "agent final answer",
  extra: Record<string, unknown> = {},
) {
  return {
    id: "mock",
    complete: async (req: {
      model: string;
      prompt: string;
      secretValue: string;
    }) => ({
      text,
      model: req.model,
      usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
      usageSource: "provider" as const,
      ...extra,
    }),
  };
}

function agentRegistry(
  providerText = "agent final answer",
  vaultValues: Record<string, string> = { openai: VAULT_SECRET },
  providerExtra: Record<string, unknown> = {},
) {
  const vault = fakeVault(vaultValues);
  const registry = createToolRegistry();
  const trim = createTextTrimTool();
  const json = createJsonExtractTool();
  registry.register(trim);
  registry.register(json);
  const provider = agentProviderDouble(providerText, providerExtra);
  registry.register(
    createAgentTool({
      providers: new Map([["mock", provider as never]]),
      resolveSecret: (ref: string, ownerId?: string) =>
        resolveSecretResource(ref, ownerId ?? OWNER, vault as never),
      tools: [trim, json],
    }),
  );
  return registry;
}

function completedAgentView(): ExecutionView {
  const output = agentResponseOutput();
  return {
    execution: {
      id: EXECUTION,
      ownerId: OWNER,
      projectId: PROJECT,
      workflowDefinitionId: randomUUID(),
      status: "completed",
      traceId: randomUUID(),
      inputContext: textInput(),
      startedAt: new Date(),
      finishedAt: new Date(),
      error: null,
      usage: {
        promptTokens: 4,
        completionTokens: 5,
        totalTokens: 9,
      } as Record<string, unknown>,
      createdAt: new Date(),
    },
    steps: [
      {
        id: randomUUID(),
        executionId: EXECUTION,
        nodeId: NODE,
        toolId: "builtin.ai.agent",
        toolVersion: "1.0.0",
        attempt: 1,
        status: "completed",
        startedAt: new Date(),
        finishedAt: new Date(),
        inputContext: textInput(),
        outputContexts: [output],
        error: null,
        idempotencyKey: null,
      },
    ],
    provenanceEdges: [],
    receipt: {},
  };
}

describe("Agent workflow server wiring", () => {
  it("server registers builtin.ai.agent@1.0.0", async () => {
    withAiMock();
    const registry = composeToolRegistry({} as never);
    const app = createApp({
      databaseReady: async () => true,
      authService: authService(),
      sessionCookie: sessionCookie(),
      toolRegistry: registry,
    });
    const res = await request(app).get("/api/tools").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const tool = (res.body.tools as { id: string; version: string }[]).find(
      (item) => item.id === "builtin.ai.agent",
    );
    expect(tool).toMatchObject({ id: "builtin.ai.agent", version: "1.0.0" });
  });

  it("a workflow node using builtin.ai.agent executes successfully", async () => {
    const registry = agentRegistry();
    const store = new FakeStore();
    const engine = createWorkflowEngine({ store, registry });
    const definition = agentGraph("secret://vault/openai", "mock");
    const created = await engine.enqueue({
      ownerId: OWNER,
      projectId: PROJECT,
      workflow: validateWorkflow(definition, registry),
      input: textInput(),
      permissions: new Set(["network", "ai"]),
      budget: { maxSteps: 12, maxDurationMs: 10_000, maxOutputBytes: 100_000 },
      traceId: randomUUID(),
    });
    const view = await engine.process(created.id, new AbortController().signal);
    expect(view.execution.status).toBe("completed");
    expect(view.steps).toHaveLength(1);
    expect(view.steps[0]?.toolId).toBe("builtin.ai.agent");
    expect(view.steps[0]?.outputContexts[0]?.type).toBe("agent_response");
  });

  it("the execution record captures the agent reasoning trace", async () => {
    const registry = agentRegistry();
    const store = new FakeStore();
    const engine = createWorkflowEngine({ store, registry });
    const definition = agentGraph("secret://vault/openai", "mock");
    const created = await engine.enqueue({
      ownerId: OWNER,
      projectId: PROJECT,
      workflow: validateWorkflow(definition, registry),
      input: textInput(),
      permissions: new Set(["network", "ai"]),
      budget: { maxSteps: 12, maxDurationMs: 10_000, maxOutputBytes: 100_000 },
      traceId: randomUUID(),
    });
    const view = await engine.process(created.id, new AbortController().signal);
    const output = view.steps[0]?.outputContexts[0];
    expect(output?.type).toBe("agent_response");
    const payload = output?.payload as {
      text: string;
      trace: Array<{ iteration: number; thought?: string }>;
    };
    expect(payload.text).toBe("agent final answer");
    expect(Array.isArray(payload.trace)).toBe(true);
    expect(payload.trace.length).toBeGreaterThan(0);
    expect(payload.trace[0]).toMatchObject({ iteration: 1 });
    expect(typeof payload.trace[0]?.thought).toBe("string");
  });

  it("sanitizes secret leaks in the persisted agent trace", async () => {
    const leakyText = `answer embeds ${VAULT_SECRET} inline`;
    const registry = agentRegistry(leakyText);
    const store = new FakeStore();
    const engine = createWorkflowEngine({ store, registry });
    const definition = agentGraph("secret://vault/openai", "mock");
    const created = await engine.enqueue({
      ownerId: OWNER,
      projectId: PROJECT,
      workflow: validateWorkflow(definition, registry),
      input: textInput(),
      permissions: new Set(["network", "ai"]),
      budget: { maxSteps: 12, maxDurationMs: 10_000, maxOutputBytes: 100_000 },
      traceId: randomUUID(),
    });
    const view = await engine.process(created.id, new AbortController().signal);
    expect(view.execution.status).toBe("completed");
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(VAULT_SECRET);
    expect(serialized).toContain("[REDACTED]");
  });

  it("send-to Document succeeds with agent_response content", async () => {
    const view = completedAgentView();
    const get = vi.fn(async () => view);
    const note = { id: randomUUID(), title: "Agent result" };
    const createNote = vi.fn(
      async (
        _ownerId: string,
        _projectId: string,
        _input: CreateNoteRequest,
        _traceId: string,
      ) => note,
    );
    const app = createApp({
      databaseReady: async () => true,
      authService: authService(),
      sessionCookie: sessionCookie(),
      projectService: {} as never,
      documentService: { createNote } as unknown as DocumentService,
      artifactService: {} as never,
      executionRepository: { get } as unknown as {
        get: typeof get;
      } & never,
    });
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/documents/from-execution`)
      .set("Cookie", cookie)
      .send({ executionId: EXECUTION, outputContextId: OUTPUT });
    expect(res.status).toBe(201);
    expect(createNote).toHaveBeenCalledTimes(1);
    expect(createNote.mock.calls[0]?.[0]).toBe(OWNER);
    expect(createNote.mock.calls[0]?.[1]).toBe(PROJECT);
    const input = createNote.mock.calls[0]?.[2] as CreateNoteRequest;
    expect(input.body).toContain("agent final answer");
    expect(typeof input.title).toBe("string");
  });
});
