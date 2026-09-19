import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuthService } from "@uw/auth";
import type { SyncChange, SyncOperation } from "@uw/contracts";
import type { SyncService } from "@uw/sync";
import { WebSocket, type WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachSyncWebSocketServer } from "../src/sync/websocket.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const OPERATION_ID = "44444444-4444-4444-8444-444444444444";
const ORIGIN = "https://app.test";
const NOW = "2026-09-19T00:00:00.000Z";

type SyncServiceWithCursor = SyncService & {
  getLatestCursor(ownerId: string): Promise<string>;
};

interface Harness {
  httpServer: Server;
  socketServer: WebSocketServer;
  url: string;
  authService: AuthService;
  syncService: SyncServiceWithCursor;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

function operation(): SyncOperation {
  return {
    id: OPERATION_ID,
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

function change(cursor: string, id = OPERATION_ID): SyncChange {
  return {
    cursor,
    operationId: id,
    entityType: "project",
    entityId: PROJECT_ID,
    kind: "upsert",
    revision: "2",
    payload: { name: "Offline" },
    createdAt: NOW,
  };
}

async function startHarness(
  options: {
    authenticated?: boolean;
    revoked?: boolean;
    latestCursor?: string;
    changes?: SyncChange[];
  } = {},
): Promise<Harness> {
  const owner = { id: OWNER_ID, username: "owner", createdAt: NOW };
  const authService = {
    isInitialized: vi.fn().mockResolvedValue(true),
    setupOwner: vi.fn(),
    login: vi.fn(),
    resolveSession: vi
      .fn()
      .mockResolvedValue(options.authenticated === false ? null : owner),
    logout: vi.fn(),
  } satisfies AuthService;

  const activeDevice = {
    id: DEVICE_ID,
    ownerId: OWNER_ID,
    name: "Browser",
    createdAt: new Date(NOW),
    lastSeenAt: new Date(NOW),
    revokedAt: options.revoked ? new Date(NOW) : null,
  };
  const changes = options.changes ?? [];
  const syncService = {
    registerDevice: vi.fn(),
    listDevices: vi.fn().mockResolvedValue([activeDevice]),
    revokeDevice: vi.fn(),
    listChanges: vi.fn().mockImplementation(async (_ownerId, cursor) => {
      return changes.filter((item) => BigInt(item.cursor) > BigInt(cursor));
    }),
    pushOperations: vi.fn().mockImplementation(async (_ownerId, operations) => {
      return operations.map((item: SyncOperation) => ({
        operationId: item.id,
        change: change("6", item.id),
      }));
    }),
    getLatestCursor: vi.fn().mockResolvedValue(options.latestCursor ?? "5"),
  } as unknown as SyncServiceWithCursor;

  const httpServer = createServer();
  const socketServer = attachSyncWebSocketServer({
    httpServer,
    authService,
    syncService,
    cookieName: "uw_session",
    allowedOrigins: [ORIGIN],
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address() as AddressInfo;
  const url = `ws://127.0.0.1:${address.port}/sync/socket`;

  cleanup.push(async () => {
    for (const client of socketServer.clients) client.terminate();
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  return { httpServer, socketServer, url, authService, syncService };
}

function connect(
  url: string,
  options: { cookie?: string; origin?: string } = {},
): WebSocket {
  const socket = new WebSocket(url, {
    origin: options.origin ?? ORIGIN,
    headers: options.cookie
      ? { Cookie: `uw_session=${options.cookie}` }
      : undefined,
  });
  socket.on("error", () => undefined);
  return socket;
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

function nextJsonMessages(
  socket: WebSocket,
  count: number,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];

    const cleanupListeners = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanupListeners();
      reject(error);
    };
    const onMessage = (
      data: Parameters<WebSocket["on"]>[1] extends (...args: infer A) => unknown
        ? A[0]
        : never,
    ) => {
      try {
        messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
        if (messages.length === count) {
          cleanupListeners();
          resolve(messages);
        }
      } catch (error) {
        cleanupListeners();
        reject(error);
      }
    };

    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once("close", (code) => resolve(code));
  });
}

function unexpectedStatus(socket: WebSocket): Promise<number | undefined> {
  return new Promise((resolve) => {
    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode);
      response.resume();
    });
  });
}

async function hello(socket: WebSocket, cursor = "0") {
  const readyPromise = nextJson(socket);
  socket.send(JSON.stringify({ type: "HELLO", deviceId: DEVICE_ID, cursor }));
  return readyPromise;
}

describe("sync WebSocket transport", () => {
  it("rejects unauthenticated upgrades", async () => {
    const harness = await startHarness({ authenticated: false });
    const socket = connect(harness.url, { origin: ORIGIN });
    expect(await unexpectedStatus(socket)).toBe(401);
  });

  it("rejects upgrades from untrusted origins", async () => {
    const harness = await startHarness();
    const socket = connect(harness.url, {
      cookie: "raw-token",
      origin: "https://evil.test",
    });
    expect(await unexpectedStatus(socket)).toBe(403);
  });

  it("sends ERROR then closes when HELLO identifies a revoked device", async () => {
    const harness = await startHarness({ revoked: true });
    const socket = connect(harness.url, { cookie: "raw-token" });
    await opened(socket);

    const closePromise = closed(socket);
    const message = await hello(socket);

    expect(message).toMatchObject({
      type: "ERROR",
      code: "DEVICE_REJECTED",
    });
    expect(await closePromise).toBe(1008);
  });

  it("returns the same ACK cursor for a duplicate PUSH_OPERATION", async () => {
    const harness = await startHarness();
    const socket = connect(harness.url, { cookie: "raw-token" });
    await opened(socket);

    expect(await hello(socket, "5")).toEqual({
      type: "READY",
      deviceId: DEVICE_ID,
      cursor: "5",
    });

    const firstAckPromise = nextJson(socket);
    socket.send(
      JSON.stringify({ type: "PUSH_OPERATION", operation: operation() }),
    );
    const firstAck = await firstAckPromise;

    const secondAckPromise = nextJson(socket);
    socket.send(
      JSON.stringify({ type: "PUSH_OPERATION", operation: operation() }),
    );
    const secondAck = await secondAckPromise;

    expect(firstAck).toMatchObject({
      type: "ACK_OPERATION",
      operationId: OPERATION_ID,
      cursor: "6",
    });
    expect(secondAck).toEqual(firstAck);
  });

  it("replays missed changes in cursor order after reconnect HELLO", async () => {
    const missed = [
      change("6", "55555555-5555-4555-8555-555555555555"),
      change("7", "66666666-6666-4666-8666-666666666666"),
    ];
    const harness = await startHarness({
      latestCursor: "7",
      changes: missed,
    });
    const socket = connect(harness.url, { cookie: "raw-token" });
    await opened(socket);

    const replayPromise = nextJsonMessages(socket, 3);
    socket.send(
      JSON.stringify({ type: "HELLO", deviceId: DEVICE_ID, cursor: "5" }),
    );
    const [ready, firstChange, secondChange] = await replayPromise;

    expect(ready).toEqual({
      type: "READY",
      deviceId: DEVICE_ID,
      cursor: "7",
    });
    expect(firstChange).toEqual({
      type: "REMOTE_OPERATION",
      change: missed[0],
    });
    expect(secondChange).toEqual({
      type: "REMOTE_OPERATION",
      change: missed[1],
    });
  });

  it("closes malformed messages with policy violation", async () => {
    const harness = await startHarness();
    const socket = connect(harness.url, { cookie: "raw-token" });
    await opened(socket);

    const closePromise = closed(socket);
    socket.send("{not-json");

    expect(await closePromise).toBe(1008);
  });

  it("closes oversized messages with message-too-big", async () => {
    const harness = await startHarness();
    const socket = connect(harness.url, { cookie: "raw-token" });
    await opened(socket);

    const closePromise = closed(socket);
    socket.send("x".repeat(1024 * 1024 + 1));

    expect(await closePromise).toBe(1009);
  });
});
