import { randomUUID } from "node:crypto";
import type { ContextEnvelope, WorkflowDefinition } from "@uw/contracts";
import type { AuthService } from "@uw/auth";
import type { ExecutionRepository, ExecutionView } from "@uw/execution";
import {
  createToolRegistry,
  createTextTrimTool,
  createJsonExtractTool,
  createHttpTool,
} from "@uw/tools";
import { createWorkflowService } from "@uw/workflow";
import type { WorkflowRepository, WorkflowVersion } from "@uw/workflow";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const WORKFLOW = "33333333-3333-4333-8333-333333333333";
const EXECUTION = "44444444-4444-4444-8444-444444444444";
const NODE = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-09-26T00:00:00.000Z";
const cookie = "uw_session=valid";

function graph(toolId = "builtin.text.trim"): WorkflowDefinition {
  return {
    id: WORKFLOW,
    projectId: PROJECT,
    name: "Example",
    schemaVersion: 1,
    nodes: [
      {
        id: NODE,
        toolId,
        toolVersion: "1.0.0",
        config: {},
        input: { source: "workflow_input" },
      },
    ],
    edges: [],
  };
}

function input(type: "text" | "json" = "text"): ContextEnvelope {
  return {
    id: randomUUID(),
    type,
    schemaVersion: 1,
    mimeType: type === "text" ? "text/plain" : "application/json",
    metadata: {},
    payload: type === "text" ? "  hello " : { value: 1 },
    provenance: { sourceContextIds: [] },
    capabilities: [],
  };
}

function setup(authenticated = true) {
  const authService = {
    isInitialized: vi.fn().mockResolvedValue(true),
    setupOwner: vi.fn(),
    login: vi.fn(),
    resolveSession: vi
      .fn()
      .mockResolvedValue(
        authenticated ? { id: OWNER, username: "owner", createdAt: NOW } : null,
      ),
    logout: vi.fn(),
  } satisfies AuthService;
  const registry = createToolRegistry();
  registry.register(createTextTrimTool());
  registry.register(createJsonExtractTool());
  registry.register(createHttpTool());

  const versions: WorkflowVersion[] = [];
  const repository: WorkflowRepository = {
    list: vi.fn(async () => versions.slice(-1)),
    get: vi.fn(
      async (_owner, _project, id) =>
        versions.findLast((item) => item.workflowId === id) ?? null,
    ),
    save: vi.fn(async (ownerId, projectId, definition, expectedVersion) => {
      const latest = versions.at(-1);
      if (latest && latest.version !== expectedVersion) throw Error("stale");
      const item: WorkflowVersion = {
        id: randomUUID(),
        workflowId: definition.id,
        version: (latest?.version ?? 0) + 1,
        ownerId,
        projectId,
        definition: structuredClone(definition),
        createdAt: new Date(NOW),
      };
      versions.push(item);
      return item;
    }),
  };
  const enqueue = vi.fn(async (options: { traceId: string }) => ({
    id: EXECUTION,
    status: "queued",
    traceId: options.traceId,
  }));
  const service = createWorkflowService({
    repository,
    registry,
    enqueue,
    allowedPermissions: [],
  });
  const execution: ExecutionView = {
    execution: {
      id: EXECUTION,
      ownerId: OWNER,
      projectId: PROJECT,
      workflowDefinitionId: randomUUID(),
      status: "queued",
      traceId: randomUUID(),
      inputContext: input(),
      startedAt: null,
      finishedAt: null,
      error: null,
      usage: {},
      createdAt: new Date(NOW),
    },
    steps: [],
    provenanceEdges: [],
    receipt: null,
  };
  const get = vi.fn(async (_owner: string, _project: string, id: string) =>
    id === EXECUTION ? execution : null,
  );
  const cancel = vi.fn(async () => {
    execution.execution.status = "cancelled";
  });
  const executionRepository = { get, cancel } as unknown as ExecutionRepository;

  const app = createApp({
    databaseReady: async () => true,
    authService,
    sessionCookie: { name: "uw_session", secure: false, maxAgeSeconds: 604800 },
    workflowService: service,
    toolRegistry: registry,
    executionRepository,
  });
  return {
    app,
    versions,
    service,
    repository,
    enqueue,
    get,
    cancel,
    execution,
  };
}

describe("protected Phase 3 workflow API", () => {
  it.each([
    ["get", "/api/tools"],
    ["get", `/api/projects/${PROJECT}/workflows`],
    ["post", `/api/projects/${PROJECT}/workflows`],
    ["get", `/api/projects/${PROJECT}/workflows/${WORKFLOW}`],
    ["post", `/api/projects/${PROJECT}/workflows/${WORKFLOW}/executions`],
    ["get", `/api/projects/${PROJECT}/executions/${EXECUTION}`],
    ["post", `/api/projects/${PROJECT}/executions/${EXECUTION}/cancel`],
  ] as const)("requires a trusted session: %s %s", async (method, path) => {
    const { app } = setup(false);
    const result = await request(app)[method](path);
    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe("UNAUTHORIZED");
  });

  it("exposes proxy-stripped paths and trusted server permission grants", async () => {
    const { app } = setup();
    const toolsResponse = await request(app)
      .get("/tools")
      .set("Cookie", cookie);
    expect(toolsResponse.status).toBe(200);
    expect(toolsResponse.body.grantedPermissions).toEqual([]);
    expect(toolsResponse.body.tools).toHaveLength(3);

    const listed = await request(app)
      .get(`/projects/${PROJECT}/workflows`)
      .set("Cookie", cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.workflows).toEqual([]);

    const anonymous = await request(app).get("/tools");
    expect(anonymous.status).toBe(401);
  });

  it("lists only registered pinned tool descriptors", async () => {
    const { app } = setup();
    const res = await request(app).get("/api/tools").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.tools.map((tool: { id: string }) => tool.id)).toEqual([
      "builtin.http.request",
      "builtin.json.extract",
      "builtin.text.trim",
    ]);
  });

  it("saves and lists a workflow under the session owner, never client owner", async () => {
    const { app, repository } = setup();
    const saved = await request(app)
      .post(`/api/projects/${PROJECT}/workflows`)
      .set("Cookie", cookie)
      .send({ definition: graph() });
    expect(saved.status).toBe(201);
    expect(repository.save).toHaveBeenCalledWith(
      OWNER,
      PROJECT,
      graph(),
      undefined,
    );
    const listed = await request(app)
      .get(`/api/projects/${PROJECT}/workflows`)
      .set("Cookie", cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.workflows).toHaveLength(1);
    const found = await request(app)
      .get(`/api/projects/${PROJECT}/workflows/${WORKFLOW}`)
      .set("Cookie", cookie);
    expect(found.status).toBe(200);
    expect(found.body.workflow.version).toBe(1);
    const spoofed = await request(app)
      .post(`/api/projects/${PROJECT}/workflows`)
      .set("Cookie", cookie)
      .send({ definition: graph(), ownerId: randomUUID(), role: "admin" });
    expect(spoofed.status).toBe(400);
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it("creates a new version without modifying the prior definition", async () => {
    const { app, versions } = setup();
    const first = graph();
    const second = { ...graph(), name: "Revised" };
    await request(app)
      .post(`/api/projects/${PROJECT}/workflows`)
      .set("Cookie", cookie)
      .send({ definition: first });
    const updated = await request(app)
      .post(`/api/projects/${PROJECT}/workflows`)
      .set("Cookie", cookie)
      .send({ definition: second, expectedVersion: 1 });
    expect(updated.status).toBe(200);
    expect(updated.body.workflow.version).toBe(2);
    expect(versions[0]?.definition.name).toBe("Example");
    expect(versions[1]?.definition.name).toBe("Revised");
  });

  it("rejects a cyclic DAG before database writes", async () => {
    const { app, repository } = setup();
    const definition = graph();
    definition.edges = [{ from: NODE, to: NODE }];
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/workflows`)
      .set("Cookie", cookie)
      .send({ definition });
    expect(res.status).toBe(400);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("rejects incompatible context bindings", async () => {
    const { app, repository } = setup();
    const definition = graph();
    definition.nodes.push({
      id: randomUUID(),
      toolId: "builtin.json.extract",
      toolVersion: "1.0.0",
      config: { path: "value" },
      input: {
        source: "node_output",
        nodeId: NODE,
        outputIndex: 0,
      },
    });
    definition.edges = [{ from: NODE, to: definition.nodes[1]!.id }];
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/workflows`)
      .set("Cookie", cookie)
      .send({ definition });
    expect(res.status).toBe(400);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("runs after preflight, returns 202, and correlates UUID trace IDs", async () => {
    const { app, enqueue } = setup();
    await request(app)
      .post(`/api/projects/${PROJECT}/workflows`)
      .set("Cookie", cookie)
      .send({ definition: graph() });
    const traceId = randomUUID();
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/workflows/${WORKFLOW}/executions`)
      .set("Cookie", cookie)
      .set("x-request-id", traceId)
      .send({ input: input() });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      executionId: EXECUTION,
      status: "queued",
      traceId,
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      ownerId: OWNER,
      projectId: PROJECT,
      workflowVersion: 1,
      traceId,
    });
  });

  it("rejects network permission before enqueue and never trusts client grants", async () => {
    const { app, enqueue } = setup();
    const definition = graph("builtin.http.request");
    definition.nodes[0]!.config = { method: "GET", url: "https://example.com" };
    await request(app)
      .post(`/api/projects/${PROJECT}/workflows`)
      .set("Cookie", cookie)
      .send({ definition });
    const url = `/api/projects/${PROJECT}/workflows/${WORKFLOW}/executions`;
    const forbidden = await request(app)
      .post(url)
      .set("Cookie", cookie)
      .send({ input: input() });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("MISSING_PERMISSION");
    expect(enqueue).not.toHaveBeenCalled();
    const spoof = await request(app)
      .post(url)
      .set("Cookie", cookie)
      .send({ input: input(), permissions: ["network"], ownerId: OWNER });
    expect(spoof.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects incompatible root input and invalid execution budgets before enqueue", async () => {
    const { app, enqueue } = setup();
    await request(app)
      .post(`/api/projects/${PROJECT}/workflows`)
      .set("Cookie", cookie)
      .send({ definition: graph() });
    const url = `/api/projects/${PROJECT}/workflows/${WORKFLOW}/executions`;
    const typeMismatch = await request(app)
      .post(url)
      .set("Cookie", cookie)
      .send({ input: input("json") });
    expect(typeMismatch.status).toBe(400);
    const invalid = await request(app)
      .post(url)
      .set("Cookie", cookie)
      .send({
        input: input(),
        budget: { maxSteps: -1, maxDurationMs: 1000, maxOutputBytes: 1000 },
      });
    expect(invalid.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("provides scoped execution details and cancels only non-terminal executions", async () => {
    const { app, get, cancel, execution } = setup();
    const detail = await request(app)
      .get(`/api/projects/${PROJECT}/executions/${EXECUTION}`)
      .set("Cookie", cookie);
    expect(detail.status).toBe(200);
    expect(get).toHaveBeenCalledWith(OWNER, PROJECT, EXECUTION);
    const cancelled = await request(app)
      .post(`/api/projects/${PROJECT}/executions/${EXECUTION}/cancel`)
      .set("Cookie", cookie)
      .send({});
    expect(cancelled.status).toBe(200);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancelled.body.execution.status).toBe("cancelled");
    execution.execution.status = "completed";
    const terminal = await request(app)
      .post(`/api/projects/${PROJECT}/executions/${EXECUTION}/cancel`)
      .set("Cookie", cookie)
      .send({});
    expect(terminal.status).toBe(409);
    expect(cancel).toHaveBeenCalledTimes(1);
    const missing = await request(app)
      .get(`/api/projects/${PROJECT}/executions/${randomUUID()}`)
      .set("Cookie", cookie);
    expect(missing.status).toBe(404);
  });
});
