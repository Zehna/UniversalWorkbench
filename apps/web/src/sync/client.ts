import {
  ServerSyncMessageSchema,
  SyncChangeSchema,
  type ServerSyncMessage,
  type SyncChange,
  type SyncOperation,
} from "@uw/contracts";

export interface SyncPushResult {
  operationId: string;
  change: SyncChange;
}

export type SyncWebSocketState = "closed" | "connecting" | "open";

export interface SyncConnection {
  close(): void;
  state(): SyncWebSocketState;
}

export interface SyncConnectOptions {
  deviceId: string;
  cursor: string;
  onMessage(message: ServerSyncMessage): void;
  onClose?(): void;
  onError?(error: Error): void;
}

export interface SyncNetworkClient {
  registerDevice(input: { id: string; name: string }): Promise<void>;
  listChanges(cursor: string, limit?: number): Promise<SyncChange[]>;
  pushOperations(operations: SyncOperation[]): Promise<SyncPushResult[]>;
  connect(options: SyncConnectOptions): SyncConnection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");

  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
  const text = await response.text();
  const body =
    text.length === 0
      ? undefined
      : (() => {
          try {
            return JSON.parse(text) as unknown;
          } catch {
            return undefined;
          }
        })();

  if (!response.ok) {
    const error =
      isRecord(body) && isRecord(body.error) ? body.error : undefined;
    const message =
      error && typeof error.message === "string"
        ? error.message
        : `Sync request failed with status ${response.status}`;
    throw new Error(message);
  }

  return body;
}

function websocketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/sync/socket`;
}

export function createBrowserSyncClient(): SyncNetworkClient {
  return {
    async registerDevice(input) {
      await request("/sync/devices", {
        method: "POST",
        body: JSON.stringify({ id: input.id, name: input.name }),
      });
    },

    async listChanges(cursor, limit = 500) {
      const body = await request(
        `/sync/changes?cursor=${encodeURIComponent(cursor)}&limit=${limit}`,
      );
      if (!isRecord(body) || !Array.isArray(body.changes)) {
        throw new Error("Invalid sync changes response");
      }
      return body.changes.map((change) => SyncChangeSchema.parse(change));
    },

    async pushOperations(operations) {
      const body = await request("/sync/operations", {
        method: "POST",
        body: JSON.stringify({ operations }),
      });
      if (!isRecord(body) || !Array.isArray(body.results)) {
        throw new Error("Invalid sync operation response");
      }
      return body.results.map((result) => {
        if (!isRecord(result) || typeof result.operationId !== "string") {
          throw new Error("Invalid sync operation result");
        }
        return {
          operationId: result.operationId,
          change: SyncChangeSchema.parse(result.change),
        };
      });
    },

    connect(options) {
      const socket = new WebSocket(websocketUrl());

      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            type: "HELLO",
            deviceId: options.deviceId,
            cursor: options.cursor,
          }),
        );
      });

      socket.addEventListener("message", (event) => {
        try {
          const raw =
            typeof event.data === "string"
              ? JSON.parse(event.data)
              : JSON.parse(String(event.data));
          const parsed = ServerSyncMessageSchema.safeParse(raw);
          if (!parsed.success) {
            options.onError?.(new Error("Invalid WebSocket sync message"));
            return;
          }
          options.onMessage(parsed.data);
        } catch {
          options.onError?.(new Error("Malformed WebSocket sync message"));
        }
      });

      socket.addEventListener("close", () => options.onClose?.());
      socket.addEventListener("error", () =>
        options.onError?.(new Error("WebSocket sync connection failed")),
      );

      return {
        state() {
          if (socket.readyState === WebSocket.OPEN) return "open";
          if (socket.readyState === WebSocket.CONNECTING) return "connecting";
          return "closed";
        },
        close() {
          if (
            socket.readyState === WebSocket.OPEN ||
            socket.readyState === WebSocket.CONNECTING
          ) {
            socket.close();
          }
        },
      };
    },
  };
}
