import type { AuthService } from "@uw/auth";
import {
  ClientSyncMessageSchema,
  type ServerSyncMessage,
  type SyncChange,
} from "@uw/contracts";
import {
  SyncDeviceRejectedError,
  type SyncService,
} from "@uw/sync";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { readCookie } from "../middleware/auth.js";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const REPLAY_BATCH_SIZE = 500;

export interface AttachSyncWebSocketServerOptions {
  httpServer: HttpServer;
  authService: AuthService;
  syncService: SyncService;
  cookieName: string;
  allowedOrigins: string[];
}

interface ConnectionContext {
  ownerId: string;
  deviceId: string | null;
}

function writeUpgradeFailure(
  socket: Duplex,
  statusCode: number,
  statusText: string,
): void {
  if (socket.destroyed) return;
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

function sendMessage(socket: WebSocket, message: ServerSyncMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function closeWithError(
  socket: WebSocket,
  code: string,
  message: string,
  closeCode = 1008,
): void {
  sendMessage(socket, { type: "ERROR", code, message });
  socket.close(closeCode, message.slice(0, 120));
}

async function activeDevice(
  syncService: SyncService,
  ownerId: string,
  deviceId: string,
): Promise<boolean> {
  const devices = await syncService.listDevices(ownerId);
  const device = devices.find((candidate) => candidate.id === deviceId);
  return Boolean(device && !device.revokedAt);
}

async function replayChanges(
  syncService: SyncService,
  ownerId: string,
  afterCursor: string,
  socket: WebSocket,
  throughCursor?: string,
): Promise<void> {
  let cursor = afterCursor;

  while (socket.readyState === WebSocket.OPEN) {
    const batch = await syncService.listChanges(
      ownerId,
      cursor,
      REPLAY_BATCH_SIZE,
    );
    if (batch.length === 0) return;

    let sent = 0;
    for (const change of batch) {
      if (
        throughCursor !== undefined &&
        BigInt(change.cursor) > BigInt(throughCursor)
      ) {
        return;
      }
      sendMessage(socket, { type: "REMOTE_OPERATION", change });
      cursor = change.cursor;
      sent += 1;

      if (
        throughCursor !== undefined &&
        BigInt(cursor) >= BigInt(throughCursor)
      ) {
        return;
      }
    }

    if (sent < REPLAY_BATCH_SIZE) return;
  }
}

function broadcastChange(
  server: WebSocketServer,
  contexts: WeakMap<WebSocket, ConnectionContext>,
  sender: WebSocket,
  ownerId: string,
  change: SyncChange,
): void {
  if (change.kind === "conflict") return;

  for (const client of server.clients) {
    if (client === sender || client.readyState !== WebSocket.OPEN) continue;
    const context = contexts.get(client);
    if (!context?.deviceId || context.ownerId !== ownerId) continue;
    sendMessage(client, { type: "REMOTE_OPERATION", change });
  }
}

export function attachSyncWebSocketServer(
  options: AttachSyncWebSocketServerOptions,
): WebSocketServer {
  const { httpServer, authService, syncService, cookieName } = options;
  const allowedOrigins = new Set(options.allowedOrigins);
  const contexts = new WeakMap<WebSocket, ConnectionContext>();

  const server = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    maxPayload: MAX_MESSAGE_BYTES,
  });

  server.on("connection", (socket) => {
    socket.on("error", () => undefined);

    socket.on("message", (data, isBinary) => {
      void (async () => {
        const context = contexts.get(socket);
        if (!context) {
          socket.close(1011, "Missing connection context");
          return;
        }

        if (isBinary) {
          closeWithError(socket, "INVALID_MESSAGE", "Binary messages are not supported");
          return;
        }

        let raw: unknown;
        try {
          raw = JSON.parse(data.toString());
        } catch {
          socket.close(1008, "Malformed JSON");
          return;
        }

        const parsed = ClientSyncMessageSchema.safeParse(raw);
        if (!parsed.success) {
          socket.close(1008, "Invalid sync message");
          return;
        }

        const message = parsed.data;

        if (message.type === "HELLO") {
          if (context.deviceId) {
            closeWithError(socket, "HELLO_ALREADY_RECEIVED", "HELLO may only be sent once");
            return;
          }

          if (!(await activeDevice(syncService, context.ownerId, message.deviceId))) {
            closeWithError(socket, "DEVICE_REJECTED", "Sync device is not active");
            return;
          }

          context.deviceId = message.deviceId;
          const latestCursor = await syncService.getLatestCursor(context.ownerId);
          sendMessage(socket, {
            type: "READY",
            deviceId: message.deviceId,
            cursor: latestCursor,
          });

          await new Promise<void>((resolve) => setImmediate(resolve));
          await replayChanges(
            syncService,
            context.ownerId,
            message.cursor,
            socket,
            latestCursor,
          );
          return;
        }

        if (!context.deviceId) {
          closeWithError(socket, "HELLO_REQUIRED", "HELLO must be sent first");
          return;
        }

        if (!(await activeDevice(syncService, context.ownerId, context.deviceId))) {
          closeWithError(socket, "DEVICE_REJECTED", "Sync device is not active");
          return;
        }

        if (message.type === "PING") {
          sendMessage(socket, { type: "PONG", nonce: message.nonce });
          return;
        }

        if (message.type === "SYNC_REQUEST") {
          const latestCursor = await syncService.getLatestCursor(context.ownerId);
          await replayChanges(
            syncService,
            context.ownerId,
            message.cursor,
            socket,
            latestCursor,
          );
          return;
        }

        if (message.operation.deviceId !== context.deviceId) {
          closeWithError(
            socket,
            "DEVICE_MISMATCH",
            "Operation device does not match HELLO device",
          );
          return;
        }

        const [result] = await syncService.pushOperations(context.ownerId, [
          message.operation,
        ]);
        if (!result) {
          throw new Error("Sync operation returned no result");
        }

        if (result.change.kind === "conflict") {
          sendMessage(socket, {
            type: "CONFLICT",
            operationId: result.operationId,
            change: result.change,
          });
          return;
        }

        sendMessage(socket, {
          type: "ACK_OPERATION",
          operationId: result.operationId,
          cursor: result.change.cursor,
          revision: result.change.revision,
        });
        broadcastChange(
          server,
          contexts,
          socket,
          context.ownerId,
          result.change,
        );
      })().catch((error: unknown) => {
        if (error instanceof SyncDeviceRejectedError) {
          closeWithError(socket, "DEVICE_REJECTED", error.message);
          return;
        }

        closeWithError(
          socket,
          "SYNC_ERROR",
          "Unexpected sync transport failure",
          1011,
        );
      });
    });
  });

  const onUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    void (async () => {
      const pathname = new URL(
        request.url ?? "/",
        "http://localhost",
      ).pathname;
      if (pathname !== "/sync/socket") {
        writeUpgradeFailure(socket, 404, "Not Found");
        return;
      }

      const origin = request.headers.origin;
      if (!origin || !allowedOrigins.has(origin)) {
        writeUpgradeFailure(socket, 403, "Forbidden");
        return;
      }

      const rawToken = readCookie(request.headers.cookie, cookieName);
      if (!rawToken) {
        writeUpgradeFailure(socket, 401, "Unauthorized");
        return;
      }

      const owner = await authService.resolveSession(rawToken);
      if (!owner) {
        writeUpgradeFailure(socket, 401, "Unauthorized");
        return;
      }

      server.handleUpgrade(request, socket, head, (websocket) => {
        contexts.set(websocket, { ownerId: owner.id, deviceId: null });
        server.emit("connection", websocket, request);
      });
    })().catch(() => {
      writeUpgradeFailure(socket, 500, "Internal Server Error");
    });
  };

  httpServer.on("upgrade", onUpgrade);
  server.once("close", () => {
    httpServer.off("upgrade", onUpgrade);
  });

  return server;
}
