import { createServer } from "node:http";
import { closeDatabasePool } from "@uw/database";
import { composeApplication } from "./composition.js";
import { loadConfig } from "./config.js";
import { attachSyncWebSocketServer } from "./sync/websocket.js";

const config = loadConfig(process.env);
const { app, pool, authService, syncService } = composeApplication(config);
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

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const client of websocketServer.clients) {
    client.terminate();
  }

  websocketServer.close(() => {
    server.close(async () => {
      await closeDatabasePool(pool);
      process.exit(0);
    });
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
