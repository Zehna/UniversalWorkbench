import { createServer, type Server } from "node:http";
import type { Express } from "express";
import type { AuthService } from "@uw/auth";
import type { ExecutionWorker } from "@uw/execution";
import type { SyncService } from "@uw/sync";
import type { WebSocketServer } from "ws";
import type { ServerConfig } from "./config.js";
import { attachSyncWebSocketServer } from "./sync/websocket.js";

export interface RuntimeComposition {
  app: Express;
  authService: AuthService;
  syncService: SyncService;
  worker: ExecutionWorker;
  close(): Promise<void>;
}

export interface RuntimeAdapters {
  createHttpServer(app: Express): Server;
  attachSyncWebSocket(input: {
    httpServer: Server;
    authService: AuthService;
    syncService: SyncService;
    cookieName: string;
    allowedOrigins: string[];
  }): WebSocketServer;
}

const defaultAdapters: RuntimeAdapters = {
  createHttpServer(app) {
    return createServer(app);
  },
  attachSyncWebSocket(input) {
    return attachSyncWebSocketServer(input);
  },
};

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export interface StartedRuntime {
  stop(): Promise<void>;
}

export function startRuntime(
  config: ServerConfig,
  composition: RuntimeComposition,
  adapters: RuntimeAdapters = defaultAdapters,
): StartedRuntime {
  let httpServer: Server | null = null;
  let websocketServer: WebSocketServer | null = null;

  if (config.appMode !== "worker") {
    httpServer = adapters.createHttpServer(composition.app);
    websocketServer = adapters.attachSyncWebSocket({
      httpServer,
      authService: composition.authService,
      syncService: composition.syncService,
      cookieName: config.sessionCookieName,
      allowedOrigins: config.trustedOrigins,
    });
    httpServer.listen(config.port, "0.0.0.0", () => {
      console.log(`Universal Workbench API listening on port ${config.port}`);
    });
  }

  if (config.appMode !== "api") {
    composition.worker.start();
  }

  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;

      await composition.worker.stop();
      if (websocketServer) await closeWebSocketServer(websocketServer);
      if (httpServer) await closeHttpServer(httpServer);
      await composition.close();
    },
  };
}
