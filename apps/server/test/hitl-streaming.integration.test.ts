import { randomUUID } from "node:crypto";
import type { ContextEnvelope } from "@uw/contracts";
import type { AuthService } from "@uw/auth";
import type { ExecutionRepository, ExecutionView } from "@uw/execution";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const EXECUTION = "44444444-4444-4444-8444-444444444444";
const NODE = "55555555-5555-4555-8555-555555555555";
const cookie = "uw_session=valid";

function textInput(): ContextEnvelope {
  return {
    id: randomUUID(),
    type: "text",
    schemaVersion: 1,
    mimeType: "text/plain",
    metadata: {},
    payload: "hello",
    provenance: { sourceContextIds: [] },
    capabilities: [],
  };
}

function awaitingView(): ExecutionView {
  return {
    execution: {
      id: EXECUTION,
      ownerId: OWNER,
      projectId: PROJECT,
      workflowDefinitionId: randomUUID(),
      status: "awaiting_approval",
      traceId: randomUUID(),
      inputContext: textInput(),
      startedAt: new Date(),
      finishedAt: null,
      error: null,
      usage: {},
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
        status: "awaiting_approval",
        startedAt: new Date(),
        finishedAt: new Date(),
        inputContext: textInput(),
        outputContexts: [
          {
            id: randomUUID(),
            type: "agent_response",
            schemaVersion: 1,
            mimeType: "application/json",
            metadata: {},
            payload: {
              text: "need approval",
              model: "mock-model",
              status: "awaiting_approval",
              iterations: 1,
              trace: [{ iteration: 1, thought: "should I call gated tool?" }],
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              usageSource: "provider",
              structured: {
                pendingApprovals: [
                  {
                    tool: "builtin.approval.gated@1.0.0",
                    toolCallId: "call_1",
                  },
                ],
              },
            },
            provenance: { sourceContextIds: [] },
            capabilities: [],
          },
        ],
        error: null,
        idempotencyKey: null,
      },
    ],
    provenanceEdges: [],
    receipt: null,
  };
}

function completedView(): ExecutionView {
  const view = awaitingView();
  view.execution.status = "completed";
  view.execution.finishedAt = new Date();
  view.steps[0]!.status = "completed";
  const output = view.steps[0]!.outputContexts[0]!;
  (output.payload as Record<string, unknown>)["status"] = "completed";
  (output.payload as Record<string, unknown>)["text"] = "agent final answer";
  return view;
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

function setup(options: {
  getImpl: (
    owner: string,
    project: string,
    id: string,
  ) => Promise<ExecutionView | null>;
  resolveApprovalImpl?: (
    id: string,
    resolution: unknown,
  ) => Promise<ExecutionView>;
}) {
  const get = vi.fn(options.getImpl);
  const resolveApproval = vi.fn(
    options.resolveApprovalImpl ?? (async () => completedView()),
  );
  const repository = { get } as unknown as ExecutionRepository;
  const engine = { resolveApproval } as unknown as {
    resolveApproval: typeof resolveApproval;
  } & never;
  const app = createApp({
    databaseReady: async () => true,
    authService: authService(),
    sessionCookie: sessionCookie(),
    executionRepository: repository,
    // Engine wiring from Task 3; routed to approve/reject handlers.
    executionEngine: engine as never,
  });
  return { app, get, resolveApproval };
}

describe("HITL streaming approval endpoints", () => {
  it("approve resumes a suspended execution to completion", async () => {
    const suspended = awaitingView();
    const done = completedView();
    const { app, resolveApproval } = setup({
      getImpl: async () => suspended,
      resolveApprovalImpl: async () => done,
    });
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/executions/${EXECUTION}/approve`)
      .set("Cookie", cookie)
      .send({});
    expect(res.status).toBe(200);
    expect(resolveApproval).toHaveBeenCalledTimes(1);
    expect(resolveApproval).toHaveBeenCalledWith(EXECUTION, {
      decision: "approved",
    });
    expect(res.body.execution.status).toBe("completed");
  });

  it("reject resumes execution passing the rejection reason", async () => {
    const suspended = awaitingView();
    const done = completedView();
    const { app, resolveApproval } = setup({
      getImpl: async () => suspended,
      resolveApprovalImpl: async (_id, resolution) => {
        expect(resolution).toMatchObject({
          decision: "rejected",
          rejectionReason: "too risky",
        });
        return done;
      },
    });
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/executions/${EXECUTION}/reject`)
      .set("Cookie", cookie)
      .send({ reason: "too risky" });
    expect(res.status).toBe(200);
    expect(resolveApproval).toHaveBeenCalledTimes(1);
    expect(res.body.execution.status).toBe("completed");
  });

  it("returns 409 when approving or rejecting an execution not awaiting approval", async () => {
    const running: ExecutionView = {
      ...awaitingView(),
      execution: { ...awaitingView().execution, status: "running" },
    };
    const { app } = setup({
      getImpl: async () => running,
      resolveApprovalImpl: async () => {
        throw Object.assign(new Error("Execution is not awaiting approval"), {
          name: "ExecutionEngineError",
          code: "INVALID_STATE",
        });
      },
    });
    const approve = await request(app)
      .post(`/api/projects/${PROJECT}/executions/${EXECUTION}/approve`)
      .set("Cookie", cookie)
      .send({});
    expect(approve.status).toBe(409);
    const reject = await request(app)
      .post(`/api/projects/${PROJECT}/executions/${EXECUTION}/reject`)
      .set("Cookie", cookie)
      .send({ reason: "nope" });
    expect(reject.status).toBe(409);
  });

  it("returns 400 for an invalid rejection body", async () => {
    const suspended = awaitingView();
    const { app, resolveApproval } = setup({
      getImpl: async () => suspended,
    });
    const res = await request(app)
      .post(`/api/projects/${PROJECT}/executions/${EXECUTION}/reject`)
      .set("Cookie", cookie)
      .send({ reason: 123 });
    expect(res.status).toBe(400);
    expect(resolveApproval).not.toHaveBeenCalled();
  });

  it("streams SSE event chunks for execution progress and agent trace", async () => {
    const done = completedView();
    const { app } = setup({
      getImpl: async () => done,
    });
    const res = await request(app)
      .get(`/api/projects/${PROJECT}/executions/${EXECUTION}/events`)
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(typeof res.text).toBe("string");
    expect(res.text).toContain("data:");
    // Every SSE frame is `data: {...}\n\n`.
    const frames = res.text!.split("\n\n").filter((f) => f.trim().length > 0);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.startsWith("data:")).toBe(true);
      const payload = JSON.parse(frame.slice("data:".length).trim());
      expect(typeof payload).toBe("object");
    }
    // Trace content is streamed, not just the terminal status.
    expect(res.text).toContain("agent final answer");
  });
});
