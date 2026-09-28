import { createServer } from "node:http";
import { closeDatabasePool, createDatabasePool } from "@uw/database";
import { composeApplication, composeWorker } from "./composition.js";
import { loadConfig, runtimeRoles } from "./config.js";
import { attachSyncWebSocketServer } from "./sync/websocket.js";

const config = loadConfig(process.env);
const roles = runtimeRoles(config.appMode);
const pool = createDatabasePool(config.databaseUrl);
const controller = new AbortController();

let httpShutdown: (() => Promise<void>) | undefined;
if (roles.http) {
  const { app, authService, syncService } = composeApplication(config, pool);
  const server = createServer(app);
  const websocketServer = attachSyncWebSocketServer({
    httpServer: server,
    authService,
    syncService,
    cookieName: config.sessionCookieName,
    allowedOrigins: config.trustedOrigins,
  });
  server.listen(config.port, "0.0.0.0", () => {
    console.log(`Universal Workbench API listening on port ${config.port}`);
  });

  httpShutdown = () =>
    new Promise<void>((resolve, reject) => {
      for (const client of websocketServer.clients) client.terminate();
      websocketServer.close(() => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    });
}

const worker = roles.worker ? composeWorker(config, pool) : undefined;
const workerTask = worker?.runUntilStopped(controller.signal);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  controller.abort();

  try {
    if (httpShutdown) await httpShutdown();
    if (workerTask) await workerTask;
    process.exitCode = 0;
  } catch (error) {
    console.error("Application shutdown failed", error);
    process.exitCode = 1;
  } finally {
    await closeDatabasePool(pool);
  }
}

void workerTask?.catch((error: unknown) => {
  console.error("Execution worker stopped unexpectedly", error);
  void shutdown();
});

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
