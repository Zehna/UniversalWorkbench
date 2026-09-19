import { spawn, spawnSync } from "node:child_process";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://workbench:workbench@127.0.0.1:5432/workbench_test";

const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  PORT: "3000",
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

run(["run", "migrate", "-w", "@uw/database"]);

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

start(["run", "dev", "-w", "@uw/server"]);
await waitFor("http://127.0.0.1:3000/health/ready");

start([
  "run",
  "dev",
  "-w",
  "@uw/web",
  "--",
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
