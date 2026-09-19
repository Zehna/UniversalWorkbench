import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AuthService } from "@uw/auth";
import type { SyncOperation } from "@uw/contracts";
import type { SyncService } from "@uw/sync";
import { createApp } from "../src/app.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-09-19T00:00:00.000Z";

function op(): SyncOperation {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    deviceId: DEVICE_ID,
    projectId: PROJECT_ID,
    entityType: "project",
    entityId: PROJECT_ID,
    action: "project.update",
    baseRevision: "1",
    payload: { name: "Offline" },
    createdAt: NOW,
  };
}

function createDeps(authenticated = true) {
  const owner = { id: OWNER_ID, username: "owner", createdAt: NOW };
  const authService = {
    isInitialized: vi.fn().mockResolvedValue(true),
    setupOwner: vi.fn(),
    login: vi.fn(),
    resolveSession: vi.fn().mockResolvedValue(authenticated ? owner : null),
    logout: vi.fn(),
  } satisfies AuthService;

  const syncService = {
    registerDevice: vi.fn().mockResolvedValue({
      id: DEVICE_ID,
      ownerId: OWNER_ID,
      name: "Browser",
      createdAt: new Date(NOW),
      lastSeenAt: new Date(NOW),
      revokedAt: null,
    }),
    listDevices: vi.fn().mockResolvedValue([]),
    revokeDevice: vi.fn().mockResolvedValue(undefined),
    listChanges: vi.fn().mockResolvedValue([]),
    pushOperations: vi.fn().mockResolvedValue([
      {
        operationId: op().id,
        change: {
          cursor: "1",
          operationId: op().id,
          entityType: "project",
          entityId: PROJECT_ID,
          kind: "upsert",
          revision: "2",
          payload: { name: "Offline" },
          createdAt: NOW,
        },
      },
    ]),
  } satisfies SyncService;

  return {
    databaseReady: async () => true,
    authService,
    sessionCookie: { name: "uw_session", secure: false, maxAgeSeconds: 604800 },
    syncService,
  };
}

describe("sync HTTP API", () => {
  it.each([
    ["get", "/sync/devices"],
    ["post", "/sync/devices"],
    ["delete", `/sync/devices/${DEVICE_ID}`],
    ["get", "/sync/changes?cursor=0"],
    ["post", "/sync/operations"],
  ] as const)("requires authentication: %s %s", async (method, path) => {
    const response = await request(createApp(createDeps(false)))[method](path);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("registers a client-generated device under the trusted owner", async () => {
    const deps = createDeps();
    const response = await request(createApp(deps))
      .post("/sync/devices")
      .set("Cookie", "uw_session=raw-token")
      .send({ id: DEVICE_ID, name: "Phone" });

    expect(response.status).toBe(201);
    expect(deps.syncService.registerDevice).toHaveBeenCalledWith(OWNER_ID, {
      id: DEVICE_ID,
      name: "Phone",
    });
  });

  it("returns changes strictly after a validated decimal cursor", async () => {
    const deps = createDeps();
    const response = await request(createApp(deps))
      .get("/sync/changes?cursor=12&limit=500")
      .set("Cookie", "uw_session=raw-token");

    expect(response.status).toBe(200);
    expect(deps.syncService.listChanges).toHaveBeenCalledWith(
      OWNER_ID,
      "12",
      500,
    );
  });

  it("rejects an invalid cursor with the shared request-correlated envelope", async () => {
    const response = await request(createApp(createDeps()))
      .get("/sync/changes?cursor=-1")
      .set("Cookie", "uw_session=raw-token");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.requestId).toBe(
      response.headers["x-request-id"],
    );
  });

  it("forwards a bounded operation batch to SyncService", async () => {
    const deps = createDeps();
    const operation = op();
    const response = await request(createApp(deps))
      .post("/sync/operations")
      .set("Cookie", "uw_session=raw-token")
      .send({ operations: [operation] });

    expect(response.status).toBe(200);
    expect(deps.syncService.pushOperations).toHaveBeenCalledWith(OWNER_ID, [
      operation,
    ]);
    expect(response.body.results[0].operationId).toBe(operation.id);
  });

  it("rejects batches larger than 100 before service mutation", async () => {
    const deps = createDeps();
    const operations = Array.from({ length: 101 }, (_, index) => ({
      ...op(),
      id: `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`,
    }));

    const response = await request(createApp(deps))
      .post("/sync/operations")
      .set("Cookie", "uw_session=raw-token")
      .send({ operations });

    expect(response.status).toBe(400);
    expect(deps.syncService.pushOperations).not.toHaveBeenCalled();
  });
});
