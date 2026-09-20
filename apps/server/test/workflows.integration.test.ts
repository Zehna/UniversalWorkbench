import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AuthService } from "@uw/auth";
import type { DocumentService } from "@uw/documents";
import type { WorkflowService } from "@uw/workflow";
import { createApp } from "../src/app.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const WORKFLOW_ID = "33333333-3333-4333-8333-333333333333";
const REVISION_ID = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-09-20T00:00:00.000Z";

const definition = {
  schemaVersion: 1 as const,
  name: "HTTP flow",
  nodes: [
    {
      id: "request",
      tool: { id: "builtin.http.request", version: "1" },
      config: { url: "https://example.com/data" },
    },
  ],
  edges: [],
  outputs: [{ name: "response", from: { nodeId: "request", output: "response" } }],
};

function workflowView() {
  return {
    document: {
      id: WORKFLOW_ID,
      projectId: PROJECT_ID,
      kind: "workflow" as const,
      title: "HTTP flow",
      currentRevisionId: REVISION_ID,
      createdAt: NOW,
      updatedAt: NOW,
    },
    revision: {
      id: REVISION_ID,
      documentId: WORKFLOW_ID,
      revisionNumber: 1,
      parentRevisionId: null,
      content: { kind: "workflow" as const, workflow: definition },
      metadata: {},
      createdAt: NOW,
    },
  };
}

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

  const documentService = {
    createNote: vi.fn(),
    updateNote: vi.fn(),
    listNotes: vi.fn().mockResolvedValue([]),
    getNote: vi.fn(),
    listRevisions: vi.fn().mockResolvedValue([]),
    createWorkflow: vi.fn().mockResolvedValue(workflowView()),
    updateWorkflow: vi.fn().mockResolvedValue(workflowView()),
    listWorkflows: vi.fn().mockResolvedValue([workflowView().document]),
    getWorkflow: vi.fn().mockResolvedValue(workflowView()),
    assertCanonicalWorkflowRevision: vi.fn().mockResolvedValue(workflowView()),
  } satisfies DocumentService;

  const workflowService = {
    validateRevision: vi.fn().mockResolvedValue(workflowView()),
    enqueueRun: vi.fn(),
  } satisfies WorkflowService;

  return {
    databaseReady: async () => true,
    authService,
    sessionCookie: {
      name: "uw_session",
      secure: false,
      maxAgeSeconds: 604800,
    },
    documentService,
    workflowService,
  };
}

describe("Phase 3 workflows API", () => {
  it("requires authentication", async () => {
    const response = await request(createApp(deps(false))).get(
      `/projects/${PROJECT_ID}/workflows`,
    );
    expect(response.status).toBe(401);
  });

  it("creates workflow documents with the trusted owner identity", async () => {
    const d = deps();
    const response = await request(createApp(d))
      .post(`/projects/${PROJECT_ID}/workflows`)
      .set("Cookie", "uw_session=raw-token")
      .send({
        ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        title: "HTTP flow",
        workflow: definition,
      });

    expect(response.status).toBe(201);
    expect(d.documentService.createWorkflow).toHaveBeenCalledWith(
      OWNER_ID,
      PROJECT_ID,
      { title: "HTTP flow", workflow: definition },
      expect.any(String),
    );
  });

  it("lists, reads, and updates workflows", async () => {
    const d = deps();
    const app = createApp(d);
    const cookie = "uw_session=raw-token";

    expect(
      (
        await request(app)
          .get(`/projects/${PROJECT_ID}/workflows`)
          .set("Cookie", cookie)
      ).status,
    ).toBe(200);

    expect(
      (
        await request(app)
          .get(`/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}`)
          .set("Cookie", cookie)
      ).status,
    ).toBe(200);

    const updated = await request(app)
      .patch(`/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}`)
      .set("Cookie", cookie)
      .send({
        title: "HTTP flow",
        workflow: definition,
        baseRevisionId: REVISION_ID,
      });
    expect(updated.status).toBe(200);
    expect(d.documentService.updateWorkflow).toHaveBeenCalledWith(
      OWNER_ID,
      PROJECT_ID,
      WORKFLOW_ID,
      expect.objectContaining({ baseRevisionId: REVISION_ID }),
      expect.any(String),
    );
  });

  it("validates a canonical revision before execution", async () => {
    const d = deps();
    const response = await request(createApp(d))
      .post(
        `/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}/validate`,
      )
      .set("Cookie", "uw_session=raw-token")
      .send({ workflowRevisionId: REVISION_ID });

    expect(response.status).toBe(200);
    expect(d.workflowService.validateRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        workflowId: WORKFLOW_ID,
        workflowRevisionId: REVISION_ID,
      }),
    );
  });
});
