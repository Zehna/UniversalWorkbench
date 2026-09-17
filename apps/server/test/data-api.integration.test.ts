import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AuthService } from "@uw/auth";
import type { ArtifactService } from "@uw/artifacts";
import type { ProjectService } from "@uw/core";
import type { DocumentService } from "@uw/documents";
import { createApp } from "../src/app.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";
const REVISION_ID = "44444444-4444-4444-8444-444444444444";
const ARTIFACT_ID = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-09-17T00:00:00.000Z";

function createDeps(authenticated = true) {
  const owner = { id: OWNER_ID, username: "owner", createdAt: NOW };
  const authService = {
    isInitialized: vi.fn().mockResolvedValue(true),
    setupOwner: vi.fn(),
    login: vi.fn(),
    resolveSession: vi.fn().mockResolvedValue(authenticated ? owner : null),
    logout: vi.fn(),
  } satisfies AuthService;

  const project = {
    id: PROJECT_ID,
    ownerId: OWNER_ID,
    name: "Research",
    description: null,
    schemaVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const projectService = {
    create: vi.fn().mockResolvedValue(project),
    list: vi.fn().mockResolvedValue([project]),
    get: vi.fn().mockResolvedValue(project),
    update: vi.fn().mockResolvedValue({ ...project, name: "Updated" }),
  } satisfies ProjectService;

  const revision = {
    id: REVISION_ID,
    documentId: DOCUMENT_ID,
    revisionNumber: 1,
    parentRevisionId: null,
    content: { body: "hello" },
    metadata: {},
    createdAt: NOW,
  };
  const document = {
    id: DOCUMENT_ID,
    projectId: PROJECT_ID,
    kind: "note" as const,
    title: "Note",
    currentRevisionId: REVISION_ID,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const documentService = {
    createNote: vi.fn().mockResolvedValue({ document, revision }),
    updateNote: vi.fn().mockResolvedValue({ document, revision }),
    listNotes: vi.fn().mockResolvedValue([document]),
    getNote: vi.fn().mockResolvedValue({ document, revision }),
    listRevisions: vi.fn().mockResolvedValue([revision]),
  } satisfies DocumentService;

  const artifact = {
    id: ARTIFACT_ID,
    projectId: PROJECT_ID,
    type: "json",
    schemaVersion: 1,
    mimeType: "application/json",
    checksumSha256: "a".repeat(64),
    sizeBytes: 2,
    storageKey: `${PROJECT_ID}/${ARTIFACT_ID}/${"a".repeat(64)}`,
    metadata: {},
    createdAt: NOW,
  };
  const artifactService = {
    create: vi.fn(),
    list: vi.fn().mockResolvedValue([artifact]),
    get: vi.fn().mockResolvedValue(artifact),
    getContent: vi.fn().mockResolvedValue(new TextEncoder().encode("{}")),
  } satisfies ArtifactService;

  return {
    databaseReady: async () => true,
    authService,
    sessionCookie: { name: "uw_session", secure: false, maxAgeSeconds: 604800 },
    projectService,
    documentService,
    artifactService,
  };
}

const protectedRoutes = [
  ["get", "/projects"],
  ["post", "/projects"],
  ["get", `/projects/${PROJECT_ID}`],
  ["patch", `/projects/${PROJECT_ID}`],
  ["get", `/projects/${PROJECT_ID}/documents`],
  ["post", `/projects/${PROJECT_ID}/documents`],
  ["get", `/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}`],
  ["patch", `/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}`],
  ["get", `/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}/revisions`],
  ["get", `/projects/${PROJECT_ID}/artifacts`],
  ["get", `/projects/${PROJECT_ID}/artifacts/${ARTIFACT_ID}`],
  ["get", `/projects/${PROJECT_ID}/artifacts/${ARTIFACT_ID}/content`],
] as const;

describe("protected data API", () => {
  it.each(protectedRoutes)("requires authentication: %s %s", async (method, path) => {
    const app = createApp(createDeps(false));
    const response = await request(app)[method](path);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("routes project mutations through ProjectService with trusted owner and trace ID", async () => {
    const deps = createDeps();
    const app = createApp(deps);
    const response = await request(app)
      .post("/projects")
      .set("Cookie", "uw_session=raw-token")
      .send({ name: "Research" });

    expect(response.status).toBe(201);
    expect(deps.projectService.create).toHaveBeenCalledWith(
      OWNER_ID,
      { name: "Research" },
      expect.any(String),
    );
  });

  it("creates and updates notes through DocumentService", async () => {
    const deps = createDeps();
    const app = createApp(deps);
    const agent = request(app);

    const created = await agent
      .post(`/projects/${PROJECT_ID}/documents`)
      .set("Cookie", "uw_session=raw-token")
      .send({ title: "Note", body: "hello" });
    expect(created.status).toBe(201);
    expect(deps.documentService.createNote).toHaveBeenCalledWith(
      OWNER_ID,
      PROJECT_ID,
      { title: "Note", body: "hello" },
      expect.any(String),
    );

    const updated = await agent
      .patch(`/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}`)
      .set("Cookie", "uw_session=raw-token")
      .send({ title: "Note", body: "next", baseRevisionId: REVISION_ID });
    expect(updated.status).toBe(200);
    expect(deps.documentService.updateNote).toHaveBeenCalled();
  });

  it("serves artifact content with stored MIME type and attachment headers", async () => {
    const deps = createDeps();
    const app = createApp(deps);
    const response = await request(app)
      .get(`/projects/${PROJECT_ID}/artifacts/${ARTIFACT_ID}/content`)
      .set("Cookie", "uw_session=raw-token");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.headers["content-length"]).toBe("2");
    expect(response.headers["content-disposition"]).toBe("attachment");
  });

  it("rejects invalid UUID params with the shared request-correlated 400 envelope", async () => {
    const app = createApp(createDeps());
    const response = await request(app)
      .get("/projects/not-a-uuid")
      .set("Cookie", "uw_session=raw-token");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.requestId).toBe(response.headers["x-request-id"]);
  });
});
