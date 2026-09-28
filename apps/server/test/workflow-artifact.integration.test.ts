import { randomUUID } from "node:crypto";
import express from "express";
import type { ArtifactService, CreateArtifactInput } from "@uw/artifacts";
import type { AuthService } from "@uw/auth";
import type { ExecutionRepository, ExecutionView } from "@uw/execution";
import type { ContextEnvelope } from "@uw/contracts";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createArtifactsRouter } from "../src/routes/artifacts.js";

const ownerId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const executionId = "33333333-3333-4333-8333-333333333333";
const outputId = "44444444-4444-4444-8444-444444444444";

const output: ContextEnvelope = {
  id: outputId,
  type: "json",
  schemaVersion: 1,
  mimeType: "application/json",
  metadata: {},
  payload: { answer: 42 },
  provenance: { sourceContextIds: [] },
  capabilities: [],
};

function fixture(status: "completed" | "running" = "completed") {
  const view: ExecutionView = {
    execution: {
      id: executionId,
      ownerId,
      projectId,
      workflowDefinitionId: randomUUID(),
      status,
      traceId: randomUUID(),
      inputContext: output,
      startedAt: new Date(),
      finishedAt: status === "completed" ? new Date() : null,
      error: null,
      usage: {},
      createdAt: new Date(),
    },
    steps: [
      {
        id: randomUUID(),
        executionId,
        nodeId: randomUUID(),
        toolId: "builtin.json.extract",
        toolVersion: "1.0.0",
        attempt: 1,
        status: "completed",
        startedAt: new Date(),
        finishedAt: new Date(),
        inputContext: output,
        outputContexts: [output],
        error: null,
        idempotencyKey: null,
      },
    ],
    provenanceEdges: [],
    receipt: {},
  };
  const get = vi.fn(
    async (owner: string, project: string, execution: string) =>
      owner === ownerId && project === projectId && execution === executionId
        ? view
        : null,
  );
  const artifact = {
    id: randomUUID(),
    projectId,
    type: "workflow-output",
    schemaVersion: 1,
    mimeType: "application/json",
    checksumSha256: "a".repeat(64),
    sizeBytes: 13,
    storageKey: "saved",
    metadata: {},
    createdAt: new Date().toISOString(),
  };
  const create = vi.fn(
    async (
      _ownerId: string,
      _projectId: string,
      _input: CreateArtifactInput,
      _traceId: string,
    ) => artifact,
  );
  const authService = {
    resolveSession: vi.fn(async () => ({
      id: ownerId,
      username: "owner",
      createdAt: new Date().toISOString(),
    })),
  } as unknown as AuthService;
  const artifacts = {
    create,
    list: vi.fn(async () => []),
    get: vi.fn(async () => artifact),
    getContent: vi.fn(async () => new Uint8Array()),
  } as unknown as ArtifactService;
  const repository = { get } as unknown as ExecutionRepository;
  const app = express();
  app.use(express.json());
  app.use(
    "/projects/:projectId/artifacts",
    createArtifactsRouter({
      authService,
      sessionCookie: {
        name: "uw_session",
        secure: false,
        maxAgeSeconds: 604800,
      },
      artifactService: artifacts,
      executionRepository: repository,
    }),
  );
  return { app, create, get, artifact };
}

describe("save workflow output via the existing ArtifactService", () => {
  it("uses the stored scoped output, never caller-submitted payload or owner", async () => {
    const { app, create, artifact } = fixture();
    const result = await request(app)
      .post(`/projects/${projectId}/artifacts/from-execution`)
      .set("Cookie", "uw_session=test")
      .send({
        executionId,
        outputContextId: outputId,
        payload: "attacker-controlled",
        ownerId: randomUUID(),
      });
    expect(result.status).toBe(400);
    expect(create).not.toHaveBeenCalled();

    const saved = await request(app)
      .post(`/projects/${projectId}/artifacts/from-execution`)
      .set("Cookie", "uw_session=test")
      .send({ executionId, outputContextId: outputId });
    expect(saved.status).toBe(201);
    expect(saved.body.artifact.id).toBe(artifact.id);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toBe(ownerId);
    expect(create.mock.calls[0]?.[1]).toBe(projectId);
    const payload = create.mock.calls[0]?.[2];
    expect(JSON.parse(new TextDecoder().decode(payload?.bytes))).toEqual({
      answer: 42,
    });
    expect(payload?.metadata).toMatchObject({
      sourceExecutionId: executionId,
      sourceContextId: outputId,
    });
  });

  it("blocks unknown, unfinished or unauthenticated output saving", async () => {
    const running = fixture("running");
    const requestPath = `/projects/${projectId}/artifacts/from-execution`;
    const rejected = await request(running.app)
      .post(requestPath)
      .set("Cookie", "uw_session=test")
      .send({ executionId, outputContextId: outputId });
    expect(rejected.status).toBe(409);
    expect(running.create).not.toHaveBeenCalled();

    const anonymous = await request(running.app)
      .post(requestPath)
      .send({ executionId, outputContextId: outputId });
    expect(anonymous.status).toBe(401);
    expect(running.create).not.toHaveBeenCalled();

    const missing = await request(running.app)
      .post(requestPath)
      .set("Cookie", "uw_session=test")
      .send({ executionId, outputContextId: randomUUID() });
    expect(missing.status).toBe(409);
  });
});
