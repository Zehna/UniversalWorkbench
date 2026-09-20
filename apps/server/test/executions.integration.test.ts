import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AuthService } from "@uw/auth";
import type { WorkflowService } from "@uw/workflow";
import type {
  DirectToolExecutionService,
  ExecutionApiService,
} from "../src/routes/executions.js";
import { createApp } from "../src/app.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const WORKFLOW_ID = "33333333-3333-4333-8333-333333333333";
const REVISION_ID = "44444444-4444-4444-8444-444444444444";
const EXECUTION_ID = "55555555-5555-4555-8555-555555555555";
const STEP_ID = "66666666-6666-4666-8666-666666666666";
const NOW = "2026-09-20T00:00:00.000Z";

const execution = {
  id: EXECUTION_ID,
  ownerId: OWNER_ID,
  projectId: PROJECT_ID,
  kind: "workflow" as const,
  workflowRevisionId: REVISION_ID,
  status: "queued" as const,
  traceId: "77777777-7777-4777-8777-777777777777",
  idempotencyKey: "run-1",
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

function deps(authenticated = true) {
  const authService = {
    isInitialized: vi.fn().mockResolvedValue(true),
    setupOwner: vi.fn(),
    login: vi.fn(),
    resolveSession: vi.fn().mockResolvedValue(
      authenticated
        ? { id: OWNER_ID, username: "owner", createdAt: NOW }
        : null,
    ),
    logout: vi.fn(),
  } satisfies AuthService;

  const executionService = {
    enqueueWorkflowExecution: vi.fn(),
    enqueueToolExecution: vi.fn(),
    list: vi.fn().mockResolvedValue([execution]),
    listSteps: vi.fn().mockResolvedValue([]),
    listOutputs: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(execution),
    requestCancellation: vi.fn().mockResolvedValue(execution),
    listReceipts: vi.fn().mockResolvedValue([]),
    listProvenance: vi.fn().mockResolvedValue([]),
  } satisfies ExecutionApiService;

  const workflowService = {
    validateRevision: vi.fn(),
    enqueueRun: vi.fn().mockResolvedValue({
      execution,
      steps: [],
    }),
  } satisfies WorkflowService;

  const directToolExecutionService = {
    enqueueToolRun: vi.fn().mockResolvedValue({
      execution: {
        id: EXECUTION_ID,
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        kind: "tool" as const,
        status: "queued" as const,
        traceId: execution.traceId,
        idempotencyKey: "tool-1",
        budget: execution.budget,
        queuedAt: NOW,
      },
      step: {
        id: STEP_ID,
        executionId: EXECUTION_ID,
        nodeId: "tool",
        toolId: "builtin.http.request",
        toolVersion: "1",
        config: { url: "https://example.com" },
        status: "queued",
        attempt: 0,
        inputContextIds: [],
        outputContextIds: [],
        startedAt: null,
        finishedAt: null,
        error: null,
        usage: { outputBytes: 0, httpRequests: 0 },
      },
    }),
  } satisfies DirectToolExecutionService;

  return {
    databaseReady: async () => true,
    authService,
    sessionCookie: {
      name: "uw_session",
      secure: false,
      maxAgeSeconds: 604800,
    },
    executionService,
    workflowService,
    directToolExecutionService,
  };
}

describe("Phase 3 executions API", () => {
  it("requires authentication", async () => {
    const response = await request(createApp(deps(false))).get(
      `/projects/${PROJECT_ID}/executions`,
    );
    expect(response.status).toBe(401);
  });

  it("enqueues a canonical workflow run with trusted ownership", async () => {
    const d = deps();
    const response = await request(createApp(d))
      .post(`/projects/${PROJECT_ID}/executions`)
      .set("Cookie", "uw_session=raw-token")
      .send({
        kind: "workflow",
        ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        workflowId: WORKFLOW_ID,
        workflowRevisionId: REVISION_ID,
        idempotencyKey: "run-1",
      });

    expect(response.status).toBe(202);
    expect(d.workflowService.enqueueRun).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        workflowId: WORKFLOW_ID,
        workflowRevisionId: REVISION_ID,
        idempotencyKey: "run-1",
      }),
    );
  });

  it("enqueues a zero-input direct tool run through the dedicated service", async () => {
    const d = deps();
    const response = await request(createApp(d))
      .post(`/projects/${PROJECT_ID}/executions`)
      .set("Cookie", "uw_session=raw-token")
      .send({
        kind: "tool",
        tool: { id: "builtin.http.request", version: "1" },
        config: { url: "https://example.com" },
        idempotencyKey: "tool-1",
      });

    expect(response.status).toBe(202);
    expect(d.directToolExecutionService.enqueueToolRun).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        tool: { id: "builtin.http.request", version: "1" },
        config: { url: "https://example.com" },
      }),
    );
  });

  it("lists, reads, cancels, and returns receipt/provenance for owned executions", async () => {
    const d = deps();
    const app = createApp(d);
    const cookie = "uw_session=raw-token";

    expect(
      (
        await request(app)
          .get(`/projects/${PROJECT_ID}/executions`)
          .set("Cookie", cookie)
      ).status,
    ).toBe(200);

    const detail = await request(app)
      .get(`/projects/${PROJECT_ID}/executions/${EXECUTION_ID}`)
      .set("Cookie", cookie);
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual({
      execution,
      steps: [],
      outputs: [],
    });

    expect(
      (
        await request(app)
          .post(
            `/projects/${PROJECT_ID}/executions/${EXECUTION_ID}/cancel`,
          )
          .set("Cookie", cookie)
      ).status,
    ).toBe(200);

    const receipt = await request(app)
      .get(
        `/projects/${PROJECT_ID}/executions/${EXECUTION_ID}/receipt`,
      )
      .set("Cookie", cookie);
    expect(receipt.status).toBe(200);
    expect(receipt.body).toEqual({
      receipts: [],
      provenance: [],
    });
  });
});
