import { closeDatabasePool } from "@uw/database";
import { composeApplication } from "./composition.js";
import { loadConfig } from "./config.js";

const config = loadConfig(process.env);
const { app, pool } = composeApplication(config);
const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`Universal Workbench API listening on port ${config.port}`);
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(async () => {
    await closeDatabasePool(pool);
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
