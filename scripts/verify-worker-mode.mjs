import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  closeDatabasePool,
  createDatabasePool,
  createPostgresExecutionRepository,
} from "@uw/database";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://workbench:workbench@127.0.0.1:5432/workbench_test";
const port = Number(process.env.WORKER_VERIFY_PORT ?? "3199");
const baseUrl = `http://127.0.0.1:${port}`;
const token = randomBytes(8).toString("hex");
const artifactsDir = `./data/worker-mode-${token}`;
const username = `worker-${token}`;
const password = `WorkerMode-${token}-Password!`;

const envBase = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  PORT: String(port),
  SESSION_COOKIE_SECURE: "false",
  TRUSTED_ORIGINS: baseUrl,
  ARTIFACTS_DIR: artifactsDir,
};

function startServer(mode) {
  return spawn(process.execPath, ["apps/server/dist/index.js"], {
    env: { ...envBase, APP_MODE: mode },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5_000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
}

async function waitForReady(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw lastError ?? new Error("API mode did not become ready");
}

function sessionCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  const cookie = setCookie?.split(";", 1)[0];
  if (!cookie) throw new Error("owner setup did not return a session cookie");
  return cookie;
}

async function json(response, expectedStatus, label) {
  const text = await response.text();
  let body;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}`);
  }
  if (response.status !== expectedStatus) {
    throw new Error(
      `${label} returned HTTP ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

async function seedExecution() {
  const setupStatus = await json(
    await fetch(`${baseUrl}/setup/status`),
    200,
    "setup status",
  );
  if (setupStatus?.initialized !== false) {
    throw new Error("worker-mode verification requires a fresh database");
  }

  const setupResponse = await fetch(`${baseUrl}/setup/owner`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  await json(setupResponse, 201, "owner setup");
  const cookie = sessionCookie(setupResponse);

  const projectBody = await json(
    await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({ name: "Worker Mode Verification" }),
    }),
    201,
    "project create",
  );
  const projectId = projectBody?.project?.id;
  if (typeof projectId !== "string") {
    throw new Error("project create response is missing project id");
  }

  const executionBody = await json(
    await fetch(`${baseUrl}/projects/${projectId}/executions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        kind: "tool",
        tool: { id: "builtin.text.template", version: "1" },
        config: { template: "worker-mode-ok" },
        idempotencyKey: `worker-mode-${token}`,
      }),
    }),
    202,
    "execution enqueue",
  );
  const executionId = executionBody?.execution?.id;
  if (typeof executionId !== "string") {
    throw new Error("execution enqueue response is missing execution id");
  }

  if (executionBody.execution.status !== "queued") {
    throw new Error(
      `API-only mode unexpectedly executed the job: ${executionBody.execution.status}`,
    );
  }

  return executionId;
}

async function assertPortStaysClosed(child, durationMs = 1_500) {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`worker process exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health/live`);
      if (response) {
        throw new Error("APP_MODE=worker opened the HTTP port");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "APP_MODE=worker opened the HTTP port"
      ) {
        throw error;
      }
    }
    await delay(100);
  }
}

async function waitForSucceeded(executionId, timeoutMs = 20_000) {
  const pool = createDatabasePool(databaseUrl);
  const executions = createPostgresExecutionRepository(pool);
  try {
    const deadline = Date.now() + timeoutMs;
    let latest = null;
    while (Date.now() < deadline) {
      latest = await executions.getByIdForWorker(executionId);
      if (!latest) throw new Error("queued execution disappeared");
      if (latest.status === "succeeded") return latest;
      if (
        ["failed", "cancelled", "timed_out"].includes(latest.status)
      ) {
        throw new Error(
          `worker execution terminated as ${latest.status}: ${JSON.stringify(latest.error ?? null)}`,
        );
      }
      await delay(100);
    }
    throw new Error(
      `worker did not finish execution; last status ${latest?.status ?? "missing"}`,
    );
  } finally {
    await closeDatabasePool(pool);
  }
}

let apiProcess;
let workerProcess;

try {
  apiProcess = startServer("api");
  await waitForReady();
  const executionId = await seedExecution();
  await stopProcess(apiProcess);
  apiProcess = undefined;

  workerProcess = startServer("worker");
  await Promise.all([
    assertPortStaysClosed(workerProcess),
    waitForSucceeded(executionId),
  ]);

  console.log("Phase 3 worker-only runtime verification passed");
} finally {
  if (apiProcess) await stopProcess(apiProcess);
  if (workerProcess) await stopProcess(workerProcess);
  await rm(artifactsDir, { recursive: true, force: true });
}
