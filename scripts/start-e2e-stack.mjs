import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://workbench:workbench@127.0.0.1:5432/workbench_test";

const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  TEST_DATABASE_URL: databaseUrl,
  PORT: "3000",
  // Phase 2 sync E2E requires API/WebSocket; workflow E2E can set E2E_APP_MODE=all.
  APP_MODE: process.env.E2E_APP_MODE ?? "all",
  NODE_ENV: "test",
  WORKBENCH_E2E_FIXTURE: "1",
  SESSION_COOKIE_SECURE: "false",
  TRUSTED_ORIGINS: "http://127.0.0.1:4173,http://localhost:4173",
};

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function run(args) {
  const result = spawnSync(npmCommand(), args, {
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function waitFor(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

run(["run", "migrate", "-w", "@uw/database"]);

// Build each package once in dependency order. The ordinary server dev script
// recursively rebuilds dependencies many times and exhausts CI startup time.
const runtimeWorkspaces = [
  "@uw/contracts",
  "@uw/shared",
  "@uw/context",
  "@uw/tools",
  "@uw/workflow",
  "@uw/execution",
  "@uw/auth",
  "@uw/core",
  "@uw/documents",
  "@uw/storage",
  "@uw/artifacts",
  "@uw/sync",
  "@uw/database",
];
for (const workspace of runtimeWorkspaces) {
  console.error(`[e2e] Building ${workspace}`);
  run([
    "exec",
    "-w",
    workspace,
    "--",
    "tsup",
    "src/index.ts",
    "--format",
    "esm",
    "--dts",
    "--clean",
  ]);
}
console.error("[e2e] Building API server");
run([
  "exec",
  "-w",
  "@uw/server",
  "--",
  "tsup",
  "src/index.ts",
  "--format",
  "esm",
  "--clean",
]);

const children = [];
function start(args) {
  const child = spawn(npmCommand(), args, {
    env,
    stdio: "inherit",
  });
  children.push(child);
  child.on("exit", (code) => {
    if (code && code !== 0) process.exitCode = code;
  });
  return child;
}

start(["exec", "-w", "@uw/server", "--", "node", "dist/index.js"]);
await waitFor("http://127.0.0.1:3000/health/ready");

start([
  "exec",
  "-w",
  "@uw/web",
  "--",
  "vite",
  "--host",
  "127.0.0.1",
  "--port",
  "4173",
]);
await waitFor("http://127.0.0.1:4173");

const shutdown = () => {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", shutdown);

await new Promise(() => {});
