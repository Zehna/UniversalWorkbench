import { composeApplication } from "./composition.js";
import { loadConfig } from "./config.js";
import { startRuntime } from "./runtime.js";

const config = loadConfig(process.env);
const composition = composeApplication(config);
const runtime = startRuntime(config, composition);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    await runtime.stop();
    process.exit(0);
  } catch (error) {
    console.error("Universal Workbench shutdown failed", error);
    process.exit(1);
  }
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
