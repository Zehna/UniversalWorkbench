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
  DELEGATION_TOOL_NAME,
} from "@uw/tools";
import type { ToolExecutor } from "@uw/tools";
import { createWorkflowEngine } from "@uw/execution";
import { validateWorkflow } from "@uw/workflow";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
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
const RESEARCHER_INSTRUCTIONS = "You are a concise research specialist.";
const cookie = "uw_session=valid";

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

function textEnvelope(payload: unknown): ContextEnvelope {
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

function agentGraph(
  secretRef = "secret://vault/openai",
  providerId = "mock",
  extraConfig: Record<string, unknown> = {},
): WorkflowDefinition {
  return {
    id: WORKFLOW,
    projectId: PROJECT,
    name: "Supervisor workflow",
    schemaVersion: 1,
    nodes: [
      {
        id: NODE,
        toolId: "builtin.ai.agent",
        toolVersion: "1.0.0",
        config: {
          providerId,
          model: "mock-model",
          prompt: "You are a supervisor. Delegate research when needed.",
          secretRef,
          allowedTools: [],
          maxIterations: 5,
          subAgents: [
            {
              id: "researcher",
              role: "researcher",
              instructions: RESEARCHER_INSTRUCTIONS,
              allowedTools: [],
              maxIterations: 5,
            },
          ],
          ...extraConfig,
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
  async suspendExecution(
    id: string,
    usage: Record<string, unknown>,
  ): Promise<void> {
    const row = this.runs.get(id)!;
    row.view.execution.status = "awaiting_approval";
    row.view.execution.usage = usage;
  }
  async resumeExecution(id: string): Promise<void> {
    const row = this.runs.get(id)!;
    row.view.execution.status = "running";
  }
  async suspend(input: {
    executionId: string;
    usage: Record<string, unknown>;
  }): Promise<void> {
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

/** Provider double that routes supervisor vs sub-agent by prompt content. */
function delegatingProviderDouble(options: {
  childText?: string;
  supervisorFinalText?: string;
  leakSecret?: string;
}) {
  let supervisorCalls = 0;
  const complete = vi.fn(async (req: Record<string, unknown>) => {
    const prompt = typeof req["prompt"] === "string" ? req["prompt"] : "";
    const isChild = prompt.includes(RESEARCHER_INSTRUCTIONS);
    if (isChild) {
      const text =
        options.leakSecret !== undefined
          ? `child embeds ${options.leakSecret} inline`
          : (options.childText ?? "child research done");
      return {
        text,
        model: "mock-model",
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        usageSource: "provider" as const,
      };
    }
    supervisorCalls += 1;
    if (supervisorCalls === 1) {
      return {
        text: "delegating to researcher",
        model: "mock-model",
        usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
        usageSource: "provider" as const,
        toolCalls: [
          {
            id: "sup_1",
            name: DELEGATION_TOOL_NAME,
            arguments: { subAgentId: "researcher", task: "summarize topic X" },
          },
        ],
      };
    }
    const text =
      options.leakSecret !== undefined
        ? `supervisor embeds ${options.leakSecret} inline`
        : (options.supervisorFinalText ?? "supervisor final with child");
    return {
      text,
      model: "mock-model",
      usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
      usageSource: "provider" as const,
    };
  });
  return { id: "mock", complete };
}

function delegatingRegistry(
  provider: { id: string; complete: unknown },
  vaultValues: Record<string, string> = { openai: VAULT_SECRET },
  extraTools: ToolExecutor[] = [],
) {
  const vault = fakeVault(vaultValues);
  const registry = createToolRegistry();
  const trim = createTextTrimTool();
  const json = createJsonExtractTool();
  registry.register(trim);
  registry.register(json);
  for (const tool of extraTools) registry.register(tool);
  registry.register(
    createAgentTool({
      providers: new Map([["mock", provider as never]]),
      resolveSecret: (ref: string, ownerId?: string) =>
        resolveSecretResource(ref, ownerId ?? OWNER, vault as never),
      tools: [trim, json, ...extraTools],
    }),
  );
  return registry;
}

function gatedTool(runImpl?: ToolExecutor["run"]): ToolExecutor {
  return {
    descriptor: {
      id: "builtin.approval.gated",
      version: "1.0.0",
      name: "builtin.approval.gated",
      description: "Gated tool",
      accepts: ["text", "json", "markdown"],
      produces: ["text"],
      permissions: [],
      capabilities: [],
      executionMode: "server",
      idempotency: "safe",
      configSchema: {},
      requiresApproval: true,
    } as unknown as ToolExecutor["descriptor"],
    run:
      runImpl ??
      (async () => ({
        outputs: [{ ...textEnvelope("gated-result"), payload: "gated-result" }],
        usage: { inputBytes: 1, outputBytes: 1 },
      })),
  };
}

/** Provider double for nested-approval: child calls gated tool, supervisor delegates. */
function nestedApprovalProviderDouble(gatedName: string) {
  let supervisorCalls = 0;
  let childCalls = 0;
  const complete = vi.fn(async (req: Record<string, unknown>) => {
    const prompt = typeof req["prompt"] === "string" ? req["prompt"] : "";
    const isChild = prompt.includes(RESEARCHER_INSTRUCTIONS);
    if (isChild) {
      childCalls += 1;
      if (childCalls <= 2) {
        return {
          text: "child needs gated tool",
          model: "mock-model",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          usageSource: "provider" as const,
          toolCalls: [{ id: "child_1", name: gatedName, arguments: {} }],
        };
      }
      return {
        text: "child done with gated-ok",
        model: "mock-model",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        usageSource: "provider" as const,
      };
    }
    supervisorCalls += 1;
    if (supervisorCalls <= 2) {
      return {
        text: "delegating to researcher",
        model: "mock-model",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        usageSource: "provider" as const,
        toolCalls: [
          {
            id: "sup_1",
            name: DELEGATION_TOOL_NAME,
            arguments: { subAgentId: "researcher", task: "do research" },
          },
        ],
      };
    }
    return {
      text: "supervisor final with gated-ok",
      model: "mock-model",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      usageSource: "provider" as const,
    };
  });
  return { id: "mock", complete };
}

function nestedApprovalRegistry(gated: ToolExecutor) {
  const gatedName = `${gated.descriptor.id}@${gated.descriptor.version}`;
  const vault = fakeVault({ openai: VAULT_SECRET });
  const provider = nestedApprovalProviderDouble(gatedName);
  const registry = createToolRegistry();
  const trim = createTextTrimTool();
  const json = createJsonExtractTool();
  registry.register(trim);
  registry.register(json);
  registry.register(gated);
  registry.register(
    createAgentTool({
      providers: new Map([["mock", provider as never]]),
      resolveSecret: (ref: string, ownerId?: string) =>
        resolveSecretResource(ref, ownerId ?? OWNER, vault as never),
      tools: [trim, json, gated as never],
    }),
  );
  return { registry, gatedName, provider };
}

function nestedApprovalGraph(
  gatedName: string,
  secretRef = "secret://vault/openai",
): WorkflowDefinition {
  return {
    id: WORKFLOW,
    projectId: PROJECT,
    name: "Nested approval workflow",
    schemaVersion: 1,
    nodes: [
      {
        id: NODE,
        toolId: "builtin.ai.agent",
        toolVersion: "1.0.0",
        config: {
          providerId: "mock",
          model: "mock-model",
          prompt: "You are a supervisor. Delegate research when needed.",
          secretRef,
          allowedTools: [],
          maxIterations: 5,
          subAgents: [
            {
              id: "researcher",
              role: "researcher",
              instructions: RESEARCHER_INSTRUCTIONS,
              allowedTools: [gatedName],
              maxIterations: 5,
            },
          ],
        },
        input: { source: "workflow_input" },
      },
    ],
    edges: [],
  };
}

function parseSseFrames(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n\n")
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => JSON.parse(frame.slice("data:".length).trim()));
}

describe("Multi-agent workflow server wiring", () => {
  it("server ToolRegistry supports supervisor agents configured with subAgents", async () => {
    process.env.WORKBENCH_AI_MOCK = "1";
    try {
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
      expect(tool).toMatchObject({
        id: "builtin.ai.agent",
        version: "1.0.0",
      });
    } finally {
      delete process.env.WORKBENCH_AI_MOCK;
    }
  });

  it("supervisor delegating to sub-agent persists nested traces in execution record", async () => {
    const provider = delegatingProviderDouble({});
    const registry = delegatingRegistry(provider);
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
    const output = view.steps[0]?.outputContexts[0];
    expect(output?.type).toBe("agent_response");
    const payload = output?.payload as {
      text: string;
      trace: Array<{
        iteration: number;
        toolCall?: { name: string };
        nestedTrace?: {
          subAgentId: string;
          role: string;
          trace: unknown[];
          status: string;
        };
      }>;
    };
    const delegateItem = payload.trace.find(
      (item) => item.toolCall?.name === DELEGATION_TOOL_NAME,
    );
    expect(delegateItem).toBeDefined();
    expect(delegateItem?.nestedTrace?.subAgentId).toBe("researcher");
    expect(delegateItem?.nestedTrace?.role).toBe("researcher");
    expect(
      Array.isArray(delegateItem?.nestedTrace?.trace) &&
        (delegateItem?.nestedTrace?.trace.length ?? 0) > 0,
    ).toBe(true);
  });

  it("sanitizes resolved secrets across nested sub-agent traces", async () => {
    const provider = delegatingProviderDouble({ leakSecret: VAULT_SECRET });
    const registry = delegatingRegistry(provider);
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

  it("SSE streaming emits sub-agent turn events with lineage", async () => {
    const provider = delegatingProviderDouble({});
    const registry = delegatingRegistry(provider);
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
    const completed = await engine.process(
      created.id,
      new AbortController().signal,
    );
    expect(completed.execution.status).toBe("completed");

    const repository = {
      get: vi.fn(async () => completed),
    };
    const app = createApp({
      databaseReady: async () => true,
      authService: authService(),
      sessionCookie: sessionCookie(),
      executionRepository: repository as unknown as WorkflowExecutionStore,
    });
    const res = await request(app)
      .get(
        `/api/projects/${PROJECT}/executions/${completed.execution.id}/events`,
      )
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const frames = parseSseFrames(res.text ?? "");
    expect(frames.length).toBeGreaterThan(0);
    const lineageFrames = frames.filter(
      (frame) =>
        typeof frame["subAgentId"] === "string" &&
        typeof frame["role"] === "string",
    );
    expect(lineageFrames.length).toBeGreaterThan(0);
    expect(
      lineageFrames.some(
        (frame) =>
          frame["subAgentId"] === "researcher" &&
          frame["role"] === "researcher",
      ),
    ).toBe(true);
  });

  it("resumes nested approval via the server approve API", async () => {
    const gatedRun = vi.fn(async () => ({
      outputs: [{ ...textEnvelope("gated-ok"), payload: "gated-ok" }],
      usage: { inputBytes: 1, outputBytes: 1 },
    }));
    const gated = gatedTool(gatedRun);
    const { registry, gatedName } = nestedApprovalRegistry(gated);
    const store = new FakeStore();
    const engine = createWorkflowEngine({ store, registry });
    const definition = nestedApprovalGraph(gatedName);
    const created = await engine.enqueue({
      ownerId: OWNER,
      projectId: PROJECT,
      workflow: validateWorkflow(definition, registry),
      input: textInput(),
      permissions: new Set(["network", "ai"]),
      budget: { maxSteps: 12, maxDurationMs: 10_000, maxOutputBytes: 100_000 },
      traceId: randomUUID(),
    });
    const suspended = await engine.process(
      created.id,
      new AbortController().signal,
    );
    expect(suspended.execution.status).toBe("awaiting_approval");
    const pending = (
      suspended.steps[0]?.outputContexts[0]?.payload as {
        structured?: { pendingApprovals?: Array<{ subAgentId?: string }> };
      }
    ).structured?.pendingApprovals;
    expect(pending?.[0]?.subAgentId).toBe("researcher");

    const app = createApp({
      databaseReady: async () => true,
      authService: authService(),
      sessionCookie: sessionCookie(),
      executionRepository: store as unknown as WorkflowExecutionStore,
      executionEngine: engine as never,
    });
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/executions/${created.id}/approve`)
      .set("Cookie", cookie)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.execution.status).toBe("completed");
    expect(gatedRun).toHaveBeenCalled();
    const finalOutput = res.body.steps[res.body.steps.length - 1]
      ?.outputContexts[0] as ContextEnvelope;
    expect(finalOutput?.type).toBe("agent_response");
    const payload = finalOutput?.payload as {
      trace: Array<{ nestedTrace?: { subAgentId: string } }>;
    };
    expect(
      payload.trace.some(
        (item) => item.nestedTrace?.subAgentId === "researcher",
      ),
    ).toBe(true);
  });

  it("send-to Document succeeds with multi-agent execution outputs", async () => {
    const provider = delegatingProviderDouble({});
    const registry = delegatingRegistry(provider);
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
    const completed = await engine.process(
      created.id,
      new AbortController().signal,
    );
    expect(completed.execution.status).toBe("completed");
    const output = completed.steps[0]?.outputContexts[0];
    expect(output?.type).toBe("agent_response");

    const get = vi.fn(async () => completed);
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
    const outputId = (output as ContextEnvelope).id;
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/documents/from-execution`)
      .set("Cookie", cookie)
      .send({ executionId: completed.execution.id, outputContextId: outputId });
    expect(res.status).toBe(201);
    expect(createNote).toHaveBeenCalledTimes(1);
    const input = createNote.mock.calls[0]?.[2] as CreateNoteRequest;
    expect(input.body).toContain("supervisor final with child");
  });
});
