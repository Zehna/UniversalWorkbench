import { randomUUID } from "node:crypto";
import type { ContextEnvelope, WorkflowDefinition } from "@uw/contracts";
import type { AuthService } from "@uw/auth";
import type { ArtifactService, CreateArtifactInput } from "@uw/artifacts";
import type { DocumentService } from "@uw/documents";
import type { CreateNoteRequest } from "@uw/contracts";
import type {
  ExecutionRepository,
  ExecutionView,
  FinishStepInput,
  StoredWorkflowRun,
  WorkflowExecutionStore,
} from "@uw/execution";
import type { ExecutionSubmission } from "@uw/execution";
import type { ExecutionRecord, ExecutionStepRecord } from "@uw/execution";
import {
  createAiTool,
  createJsonExtractTool,
  createTextTrimTool,
  createToolRegistry,
} from "@uw/tools";
import { createWorkflowEngine } from "@uw/execution";
import { createWorkflowService } from "@uw/workflow";
import type { WorkflowRepository, WorkflowVersion } from "@uw/workflow";
import { validateWorkflow } from "@uw/workflow";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { composeToolRegistry } from "../src/composition.js";
import { resolveSecretResource } from "../src/secrets/resolve.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "99999999-9999-4999-8999-999999999999";
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

function aiResponseOutput(
  text = "mock answer",
  usage = { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
): ContextEnvelope {
  return {
    id: OUTPUT,
    type: "ai_response",
    schemaVersion: 1,
    mimeType: "application/json",
    metadata: {},
    payload: { text, model: "mock-model", usage, usageSource: "provider" },
    provenance: { sourceContextIds: [] },
    capabilities: [],
  };
}

function aiGraph(secretRef: string, providerId = "mock"): WorkflowDefinition {
  return {
    id: WORKFLOW,
    projectId: PROJECT,
    name: "AI workflow",
    schemaVersion: 1,
    nodes: [
      {
        id: NODE,
        toolId: "builtin.ai.complete",
        toolVersion: "1.0.0",
        config: {
          providerId,
          model: "mock-model",
          prompt: "Summarize:",
          secretRef,
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

function portDouble(id = "mock") {
  return {
    id,
    complete: async (req: {
      model: string;
      prompt: string;
      secretValue: string;
    }) => ({
      text: `mock:${req.model}:${req.prompt.slice(0, 32)}`,
      model: req.model,
      usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
      usageSource: "estimated" as const,
    }),
  };
}

function completedAiView(owner = OWNER): ExecutionView {
  const output = aiResponseOutput();
  return {
    execution: {
      id: EXECUTION,
      ownerId: owner,
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
        toolId: "builtin.ai.complete",
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

describe("AI workflow API wiring", () => {
  it("catalog contains builtin.ai.complete@1.0.0", async () => {
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
      (item) => item.id === "builtin.ai.complete",
    );
    expect(tool).toMatchObject({ id: "builtin.ai.complete", version: "1.0.0" });
  });

  it("rejects AI runs without the ai grant before enqueue", async () => {
    withAiMock();
    const registry = composeToolRegistry({} as never);
    const versions: WorkflowVersion[] = [
      {
        id: randomUUID(),
        workflowId: WORKFLOW,
        version: 1,
        ownerId: OWNER,
        projectId: PROJECT,
        definition: aiGraph("secret://vault/openai"),
        createdAt: new Date(),
      },
    ];
    const repository: WorkflowRepository = {
      list: vi.fn(async () => versions.slice(-1)),
      get: vi.fn(async () => versions[0]!),
      save: vi.fn(),
    };
    const enqueue = vi.fn();
    const service = createWorkflowService({
      repository,
      registry,
      enqueue: enqueue as never,
      allowedPermissions: [],
    });
    const app = createApp({
      databaseReady: async () => true,
      authService: authService(),
      sessionCookie: sessionCookie(),
      workflowService: service,
      toolRegistry: registry,
    });
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/workflows/${WORKFLOW}/executions`)
      .set("Cookie", cookie)
      .send({ input: textInput() });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("MISSING_PERMISSION");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("fails secret://local runs with a typed code, one attempt, no leak", async () => {
    const vault = fakeVault({ openai: VAULT_SECRET });
    const registry = createToolRegistry();
    registry.register(createTextTrimTool());
    registry.register(createJsonExtractTool());
    registry.register(
      createAiTool({
        providers: new Map([["mock", portDouble() as never]]),
        resolveSecret: (ref: string, ownerId?: string) =>
          resolveSecretResource(ref, ownerId ?? OWNER, vault as never),
      }),
    );
    const store = new FakeStore();
    const engine = createWorkflowEngine({ store, registry });
    const definition = aiGraph("secret://local/device-key");
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
    expect(view.execution.status).toBe("failed");
    expect(view.steps).toHaveLength(1);
    expect(view.steps[0]?.error?.code).toBe(
      "LOCAL_SECRET_NOT_AVAILABLE_ON_SERVER",
    );
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(VAULT_SECRET);
    expect(serialized).not.toContain("device-key-value");
  });

  it("from-execution accepts ai_response outputs as artifacts", async () => {
    const view = completedAiView();
    const get = vi.fn(async () => view);
    const artifact = { id: randomUUID() };
    const create = vi.fn(
      async (
        _ownerId: string,
        _projectId: string,
        _input: CreateArtifactInput,
        _traceId: string,
      ) => artifact,
    );
    const app = createApp({
      databaseReady: async () => true,
      authService: authService(),
      sessionCookie: sessionCookie(),
      projectService: {} as never,
      documentService: {} as never,
      artifactService: { create } as unknown as ArtifactService,
      executionRepository: { get } as unknown as ExecutionRepository,
    });
    const res = await request(app)
      .post(`/projects/${PROJECT}/artifacts/from-execution`)
      .set("Cookie", cookie)
      .send({ executionId: EXECUTION, outputContextId: OUTPUT });
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
    const bytes = create.mock.calls[0]?.[2].bytes as Uint8Array;
    expect(JSON.parse(new TextDecoder().decode(bytes)).text).toBe(
      "mock answer",
    );
  });

  it("documents/from-execution saves ai_response output as a note", async () => {
    const view = completedAiView();
    const get = vi.fn(async () => view);
    const note = { id: randomUUID(), title: "AI result" };
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
      artifactService: {} as unknown as ArtifactService,
      executionRepository: { get } as unknown as ExecutionRepository,
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
    expect(input.body).toContain("mock answer");
    expect(typeof input.title).toBe("string");
  });

  it("conceals cross-owner executions on send-to routes", async () => {
    const view = completedAiView(OWNER_B);
    const get = vi.fn(async (owner: string, _project: string, _id: string) =>
      owner === OWNER_B ? view : null,
    );
    const create = vi.fn();
    const createNote = vi.fn();
    const app = createApp({
      databaseReady: async () => true,
      authService: authService(),
      sessionCookie: sessionCookie(),
      projectService: {} as never,
      documentService: { createNote } as unknown as DocumentService,
      artifactService: { create } as unknown as ArtifactService,
      executionRepository: { get } as unknown as ExecutionRepository,
    });
    const artifactRes = await request(app)
      .post(`/projects/${PROJECT}/artifacts/from-execution`)
      .set("Cookie", cookie)
      .send({ executionId: EXECUTION, outputContextId: OUTPUT });
    expect(artifactRes.status).toBe(404);
    const docRes = await request(app)
      .post(`/api/projects/${PROJECT}/documents/from-execution`)
      .set("Cookie", cookie)
      .send({ executionId: EXECUTION, outputContextId: OUTPUT });
    expect(docRes.status).toBe(404);
    expect(create).not.toHaveBeenCalled();
    expect(createNote).not.toHaveBeenCalled();
  });

  it("production composition registers no mock provider and fails closed", async () => {
    const registry = composeToolRegistry({} as never);
    const store = new FakeStore();
    const engine = createWorkflowEngine({ store, registry });
    const definition = aiGraph("secret://vault/openai", "mock");
    const created = await engine.enqueue({
      ownerId: OWNER,
      projectId: PROJECT,
      workflow: validateWorkflow(definition, registry),
      input: textInput(),
      permissions: new Set(["network", "ai"]),
      budget: { maxSteps: 4, maxDurationMs: 10_000, maxOutputBytes: 100_000 },
      traceId: randomUUID(),
    });
    const view = await engine.process(created.id, new AbortController().signal);
    expect(view.execution.status).toBe("failed");
    expect(view.steps[0]?.error?.code).toBe("AI_PROVIDER_NOT_CONFIGURED");
    expect(JSON.stringify(view)).not.toContain(VAULT_SECRET);
  });
});

describe("resolveSecretResource", () => {
  it("resolves vault refs through the store and rejects local refs", async () => {
    const vault = fakeVault({ openai: VAULT_SECRET });
    await expect(
      resolveSecretResource("secret://vault/openai", OWNER, vault as never),
    ).resolves.toBe(VAULT_SECRET);
    expect(vault.get).toHaveBeenCalledWith(OWNER, "openai");
    await expect(
      resolveSecretResource("secret://local/device", OWNER, vault as never),
    ).rejects.toMatchObject({ code: "LOCAL_SECRET_NOT_AVAILABLE_ON_SERVER" });
  });

  it("fails closed on unknown names and malformed refs without leaks", async () => {
    const vault = fakeVault({});
    await expect(
      resolveSecretResource("secret://vault/missing", OWNER, vault as never),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await expect(
      resolveSecretResource("https://evil.example/k", OWNER, vault as never),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    const failures = await Promise.allSettled([
      resolveSecretResource("secret://vault/missing", OWNER, vault as never),
      resolveSecretResource("secret://local/x", OWNER, vault as never),
    ]);
    for (const result of failures) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(String(result.reason)).not.toContain(VAULT_SECRET);
      }
    }
  });
});
