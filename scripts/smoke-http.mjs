import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8080";
const maxAttempts = Number(process.env.SMOKE_MAX_ATTEMPTS ?? "30");
const retryDelayMs = Number(process.env.SMOKE_RETRY_DELAY_MS ?? "1000");
const secretCanary =
  process.env.SMOKE_SECRET_CANARY ??
  `phase2-smoke-${randomBytes(24).toString("base64url")}`;
// Distinct AI-key canary: the plaintext stored as the vault AI secret. The
// no-secrets gate scans deployment logs for both canaries.
const aiKeyCanary =
  process.env.SMOKE_AI_KEY ??
  `phase4-ai-${randomBytes(24).toString("base64url")}`;

const sleep = (milliseconds) =>
  new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));

async function waitFor(label, check) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(retryDelayMs);
    }
  }

  const detail =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label} did not become ready: ${detail}`);
}

async function readJson(response, label) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}`);
  }
  return body;
}

async function expectJson(response, expectedStatus, label) {
  const body = await readJson(response, label);
  if (response.status !== expectedStatus) {
    throw new Error(
      `${label} returned HTTP ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

function sessionCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  const cookie = setCookie?.split(";", 1)[0];
  if (!cookie) throw new Error("owner setup did not return a session cookie");
  return cookie;
}

function latestCursor(changes) {
  return changes.at(-1)?.cursor ?? "0";
}

function operation(input) {
  return {
    id: input.id ?? randomUUID(),
    deviceId: input.deviceId,
    projectId: input.projectId,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    baseRevision: input.baseRevision,
    payload: input.payload,
    createdAt: new Date().toISOString(),
  };
}

const api = (path) => `${baseUrl}/api${path}`;

async function syncChanges(cookie, cursor = "0") {
  const body = await expectJson(
    await fetch(
      api(`/sync/changes?cursor=${encodeURIComponent(cursor)}&limit=500`),
      {
        headers: { cookie },
      },
    ),
    200,
    "sync changes",
  );
  if (!Array.isArray(body.changes)) {
    throw new Error("sync changes response is missing changes");
  }
  return body.changes;
}

async function push(cookie, op, expectedStatus = 200) {
  return expectJson(
    await fetch(api("/sync/operations"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({ operations: [op] }),
    }),
    expectedStatus,
    `sync operation ${op.action}`,
  );
}

function websocketUrl() {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/sync/socket";
  url.search = "";
  return url.toString();
}

async function websocketCatchUp(cookie, deviceId, cursor, expectedChanges) {
  const socket = new WebSocket(websocketUrl(), {
    origin: baseUrl,
    headers: { Cookie: cookie },
  });

  const messages = [];
  await new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(
      () => reject(new Error("WebSocket catch-up timed out")),
      15_000,
    );

    const finish = (callback) => {
      globalThis.clearTimeout(timer);
      callback();
    };

    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("open", () => {
      socket.send(JSON.stringify({ type: "HELLO", deviceId, cursor }));
    });
    socket.on("message", (data) => {
      try {
        messages.push(JSON.parse(data.toString()));
        if (messages.length === expectedChanges.length + 1) {
          finish(resolve);
        }
      } catch (error) {
        finish(() => reject(error));
      }
    });
  });

  socket.close();

  const [ready, ...remote] = messages;
  if (ready?.type !== "READY") {
    throw new Error("WebSocket did not begin catch-up with READY");
  }
  const received = remote.map((message) => message.change?.operationId);
  const expected = expectedChanges.map((change) => change.operationId);
  if (JSON.stringify(received) !== JSON.stringify(expected)) {
    throw new Error("WebSocket catch-up did not preserve cursor order");
  }
}

await waitFor("web shell", async () => {
  const response = await fetch(baseUrl);
  const body = await response.text();
  if (!response.ok || !body.includes("root")) {
    throw new Error(`received HTTP ${response.status}`);
  }
});

await waitFor("API liveness", async () => {
  const response = await fetch(api("/health/live"));
  const body = await response.json();
  if (!response.ok || body.status !== "ok") {
    throw new Error(`received HTTP ${response.status}`);
  }
});

await waitFor("API readiness", async () => {
  const response = await fetch(api("/health/ready"));
  const body = await response.json();
  if (!response.ok || body.status !== "ready") {
    throw new Error(`received HTTP ${response.status}`);
  }
});

const rootResponse = await fetch(baseUrl);
if (
  rootResponse.headers.get("cross-origin-opener-policy") !== "same-origin" ||
  rootResponse.headers.get("cross-origin-embedder-policy") !== "require-corp"
) {
  throw new Error("PWA isolation headers are missing");
}

const setupStatus = await expectJson(
  await fetch(api("/setup/status")),
  200,
  "setup status",
);
if (setupStatus.initialized !== false) {
  throw new Error("fresh deployment is already initialized");
}

const username = `smoke-${randomBytes(6).toString("hex")}`;
const setupResponse = await fetch(api("/setup/owner"), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password: secretCanary }),
});
const setupBody = await expectJson(setupResponse, 201, "owner setup");
if (setupBody.owner?.username !== username) {
  throw new Error("owner setup returned the wrong owner");
}
const cookie = sessionCookie(setupResponse);

const deviceA = randomUUID();
const deviceB = randomUUID();
for (const [id, name] of [
  [deviceA, "Smoke device A"],
  [deviceB, "Smoke device B"],
]) {
  await expectJson(
    await fetch(api("/sync/devices"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ id, name }),
    }),
    201,
    `register ${name}`,
  );
}

const projectId = randomUUID();
const projectCreate = operation({
  deviceId: deviceA,
  projectId,
  entityType: "project",
  entityId: projectId,
  action: "project.create",
  baseRevision: null,
  payload: { name: "Phase 2 Smoke Project", description: null },
});
const projectResult = await push(cookie, projectCreate);
const projectChange = projectResult.results?.[0]?.change;
if (projectChange?.kind !== "upsert" || projectChange.revision !== "1") {
  throw new Error("project sync create did not return revision 1");
}

const deviceBCatchUp = await syncChanges(cookie, "0");
if (!deviceBCatchUp.some((change) => change.operationId === projectCreate.id)) {
  throw new Error("device B HTTP recovery missed project create");
}
const deviceBCursor = projectChange.cursor;

const documentId = randomUUID();
const noteCreate = operation({
  deviceId: deviceA,
  projectId,
  entityType: "document",
  entityId: documentId,
  action: "document.create",
  baseRevision: null,
  payload: { title: "Smoke note", body: "revision one" },
});
const noteCreateResult = await push(cookie, noteCreate);
const noteCreateChange = noteCreateResult.results?.[0]?.change;
if (
  noteCreateChange?.kind !== "upsert" ||
  typeof noteCreateChange.revision !== "string"
) {
  throw new Error("note sync create did not return a canonical revision");
}

const noteUpdate = operation({
  deviceId: deviceA,
  projectId,
  entityType: "document",
  entityId: documentId,
  action: "document.update",
  baseRevision: noteCreateChange.revision,
  payload: { title: "Smoke note", body: "revision two" },
});
const noteUpdateResult = await push(cookie, noteUpdate);
const noteUpdateChange = noteUpdateResult.results?.[0]?.change;
if (
  noteUpdateChange?.kind !== "upsert" ||
  typeof noteUpdateChange.revision !== "string" ||
  noteUpdateChange.revision === noteCreateChange.revision
) {
  throw new Error("note sync update did not advance the revision");
}

const beforeReplay = await syncChanges(cookie, "0");
const beforeReplayCursor = latestCursor(beforeReplay);
const replay = await push(cookie, noteUpdate);
const replayChange = replay.results?.[0]?.change;
const afterReplay = await syncChanges(cookie, "0");
if (
  replayChange?.cursor !== noteUpdateChange.cursor ||
  latestCursor(afterReplay) !== beforeReplayCursor ||
  afterReplay.length !== beforeReplay.length
) {
  throw new Error("duplicate operation advanced the durable cursor");
}

const staleUpdate = operation({
  deviceId: deviceB,
  projectId,
  entityType: "document",
  entityId: documentId,
  action: "document.update",
  baseRevision: noteCreateChange.revision,
  payload: { title: "Smoke note", body: "stale offline body" },
});
const staleResult = await push(cookie, staleUpdate);
const staleChange = staleResult.results?.[0]?.change;
if (
  staleChange?.kind !== "conflict" ||
  staleChange.revision !== noteUpdateChange.revision ||
  staleChange.payload?.current?.body !== "revision two"
) {
  throw new Error("stale sync update did not preserve canonical note content");
}

const canonicalNote = await expectJson(
  await fetch(api(`/projects/${projectId}/documents/${documentId}`), {
    headers: { cookie },
  }),
  200,
  "canonical note read",
);
if (canonicalNote.revision?.content?.body !== "revision two") {
  throw new Error("stale sync update overwrote the canonical note");
}

const persistedChanges = await syncChanges(cookie, "0");
const persistedText = JSON.stringify(persistedChanges);
if (
  persistedText.includes(secretCanary) ||
  /uw_session|cookie|password/i.test(persistedText)
) {
  throw new Error("persisted sync change payload contains credential data");
}

const revokeResponse = await fetch(api(`/sync/devices/${deviceA}`), {
  method: "DELETE",
  headers: { cookie },
});
if (revokeResponse.status !== 204) {
  throw new Error(`device A revocation returned HTTP ${revokeResponse.status}`);
}

const rejected = await push(
  cookie,
  operation({
    deviceId: deviceA,
    projectId: randomUUID(),
    entityType: "project",
    entityId: randomUUID(),
    action: "project.create",
    baseRevision: null,
    payload: { name: "Rejected after revoke" },
  }),
  403,
);
if (rejected.error?.code !== "SYNC_DEVICE_REJECTED") {
  throw new Error("revoked device push did not return SYNC_DEVICE_REJECTED");
}

const missedByB = await syncChanges(cookie, deviceBCursor);
await websocketCatchUp(cookie, deviceB, deviceBCursor, missedByB);

// --- Phase 3 workflow smoke (HTTP -> JSON, receipt, Artifact, cancel) ---
// Requires the deterministic Docker smoke fixture:
// WORKBENCH_DOCKER_SMOKE_FIXTURE=1 when starting the deployment. Without it
// the run endpoint has no network grant and this section fails by design.
const FIXTURE_HTTP_URL = "https://fixture.workbench.dev/response";

function workflowEnvelope(type, payload, mimeType) {
  return {
    id: randomUUID(),
    type,
    schemaVersion: 1,
    mimeType,
    metadata: {},
    payload,
    provenance: { sourceContextIds: [] },
    capabilities: [],
  };
}

async function pollExecution(cookie, projectId, executionId, label) {
  const deadline = Date.now() + 60_000;
  let view;
  for (;;) {
    view = await expectJson(
      await fetch(api(`/projects/${projectId}/executions/${executionId}`), {
        headers: { cookie },
      }),
      200,
      `${label} status`,
    );
    const status = view.execution?.status;
    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      return view;
    }
    if (Date.now() > deadline) {
      throw new Error(`${label} did not reach a terminal status in 60s`);
    }
    await sleep(1000);
  }
}

const toolsCatalog = await expectJson(
  await fetch(api("/tools"), { headers: { cookie } }),
  200,
  "tool catalog",
);
for (const toolId of [
  "builtin.http.request",
  "builtin.json.extract",
  "builtin.text.trim",
  "builtin.markdown.to-text",
]) {
  if (!toolsCatalog.tools?.some((tool) => tool.id === toolId)) {
    throw new Error(
      `tool catalog is missing ${toolId}; is the Phase 3 deployment running?`,
    );
  }
}

const httpNodeId = randomUUID();
const extractNodeId = randomUUID();
const smokeWorkflowId = randomUUID();
const smokeWorkflow = {
  id: smokeWorkflowId,
  projectId,
  name: "Phase 3 Smoke HTTP JSON",
  schemaVersion: 1,
  nodes: [
    {
      id: httpNodeId,
      toolId: "builtin.http.request",
      toolVersion: "1.0.0",
      config: { method: "GET", url: FIXTURE_HTTP_URL },
      input: { source: "workflow_input" },
    },
    {
      id: extractNodeId,
      toolId: "builtin.json.extract",
      toolVersion: "1.0.0",
      config: { path: "answer" },
      input: { source: "node_output", nodeId: httpNodeId, outputIndex: 0 },
    },
  ],
  edges: [{ from: httpNodeId, to: extractNodeId }],
};

const savedWorkflow = await expectJson(
  await fetch(api(`/projects/${projectId}/workflows`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ definition: smokeWorkflow }),
  }),
  201,
  "workflow save",
);
if (savedWorkflow.workflow?.workflowId !== smokeWorkflowId) {
  throw new Error("workflow save returned the wrong workflow");
}

const enqueued = await expectJson(
  await fetch(
    api(`/projects/${projectId}/workflows/${smokeWorkflowId}/executions`),
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        input: workflowEnvelope("json", {}, "application/json"),
      }),
    },
  ),
  202,
  "workflow run (HTTP -> JSON)",
);
if (typeof enqueued.executionId !== "string") {
  throw new Error("workflow run did not return an executionId");
}

const completed = await pollExecution(
  cookie,
  projectId,
  enqueued.executionId,
  "HTTP -> JSON execution",
);
if (completed.execution.status !== "completed") {
  throw new Error(
    `HTTP -> JSON execution ended as ${completed.execution.status}: ${JSON.stringify(completed.execution.error ?? completed.receipt ?? {})}`,
  );
}
const smokeSteps = completed.steps ?? [];
if (
  smokeSteps.map((step) => step.toolId).join(",") !==
  "builtin.http.request,builtin.json.extract"
) {
  throw new Error("HTTP -> JSON execution did not run both pinned tools");
}
const extractedOutput = smokeSteps[1]?.outputContexts?.[0];
if (extractedOutput?.payload !== 42) {
  throw new Error(
    `JSON extract did not yield the fixture answer: ${JSON.stringify(extractedOutput?.payload)}`,
  );
}
if (
  !completed.receipt ||
  completed.receipt.status !== "completed" ||
  !Array.isArray(completed.receipt.outputContextIds) ||
  !completed.receipt.outputContextIds.includes(extractedOutput.id) ||
  !Array.isArray(completed.receipt.provenance) ||
  completed.receipt.provenance.length < 2
) {
  throw new Error("completed execution receipt is missing outputs/provenance");
}
const completedText = JSON.stringify(completed);
if (
  completedText.includes(secretCanary) ||
  /uw_session|password/i.test(completedText)
) {
  throw new Error("execution view contains credential material");
}

const savedArtifact = await expectJson(
  await fetch(api(`/projects/${projectId}/artifacts/from-execution`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      executionId: enqueued.executionId,
      outputContextId: extractedOutput.id,
    }),
  }),
  201,
  "save execution output as artifact",
);
const artifactId = savedArtifact.artifact?.id;
if (typeof artifactId !== "string") {
  throw new Error("artifact save did not return an artifact id");
}
const fetchedArtifact = await expectJson(
  await fetch(api(`/projects/${projectId}/artifacts/${artifactId}`), {
    headers: { cookie },
  }),
  200,
  "artifact read",
);
if (fetchedArtifact.artifact?.id !== artifactId) {
  throw new Error("artifact read returned the wrong artifact");
}

// Cancellation: a second execution is enqueued then cancelled. Either the
// cancel wins (status cancelled) or the worker already finished it (409 with
// EXECUTION_NOT_CANCELLABLE); both prove the cancellation gate.
const trimNodeId = randomUUID();
const trimWorkflowId = randomUUID();
await expectJson(
  await fetch(api(`/projects/${projectId}/workflows`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      definition: {
        id: trimWorkflowId,
        projectId,
        name: "Phase 3 Smoke Cancel",
        schemaVersion: 1,
        nodes: [
          {
            id: trimNodeId,
            toolId: "builtin.text.trim",
            toolVersion: "1.0.0",
            config: {},
            input: { source: "workflow_input" },
          },
        ],
        edges: [],
      },
    }),
  }),
  201,
  "cancel workflow save",
);
const enqueuedTrim = await expectJson(
  await fetch(
    api(`/projects/${projectId}/workflows/${trimWorkflowId}/executions`),
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        input: workflowEnvelope("text", "  hello smoke  ", "text/plain"),
      }),
    },
  ),
  202,
  "cancel workflow run",
);
const cancelResponse = await fetch(
  api(`/projects/${projectId}/executions/${enqueuedTrim.executionId}/cancel`),
  { method: "POST", headers: { cookie } },
);
if (cancelResponse.status === 200) {
  const cancelled = await readJson(cancelResponse, "execution cancel");
  if (cancelled.execution?.status !== "cancelled") {
    throw new Error("execution cancel did not transition to cancelled");
  }
} else if (cancelResponse.status === 409) {
  const conflict = await readJson(cancelResponse, "execution cancel");
  if (conflict.error?.code !== "EXECUTION_NOT_CANCELLABLE") {
    throw new Error(
      `execution cancel returned unexpected 409: ${JSON.stringify(conflict)}`,
    );
  }
} else {
  throw new Error(`execution cancel returned HTTP ${cancelResponse.status}`);
}
const cancelFinal = await pollExecution(
  cookie,
  projectId,
  enqueuedTrim.executionId,
  "cancelled execution",
);
if (
  !["cancelled", "completed", "failed"].includes(cancelFinal.execution.status)
) {
  throw new Error(
    `cancelled execution ended as ${cancelFinal.execution.status}`,
  );
}

console.log("docker Phase 3 workflow smoke passed");

// --- Phase 4 AI smoke (vault -> HTTP -> JSON -> AI -> Note/Artifact) ---
// Requires the Docker smoke fixture (WORKBENCH_DOCKER_SMOKE_FIXTURE=1, which
// registers the mock AI provider) and a vault keyring (VAULT_MASTER_KEYS)
// when starting the deployment. Without them this section fails by design.
const vaultHealth = await expectJson(
  await fetch(api("/vault/health"), { headers: { cookie } }),
  200,
  "vault health",
);
if (vaultHealth.configured !== true) {
  throw new Error(
    "vault keyring is not configured; set VAULT_MASTER_KEYS for the deployment",
  );
}
await expectJson(
  await fetch(api("/vault/e2e-ai"), {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ value: aiKeyCanary }),
  }),
  200,
  "vault secret put",
);
if (!toolsCatalog.tools?.some((tool) => tool.id === "builtin.ai.complete")) {
  throw new Error(
    "tool catalog is missing builtin.ai.complete; is the Phase 4 deployment running?",
  );
}

const aiHttpNodeId = randomUUID();
const aiExtractNodeId = randomUUID();
const aiNodeId = randomUUID();
const aiWorkflowId = randomUUID();
const aiWorkflow = {
  id: aiWorkflowId,
  projectId,
  name: "Phase 4 Smoke HTTP JSON AI",
  schemaVersion: 1,
  nodes: [
    {
      id: aiHttpNodeId,
      toolId: "builtin.http.request",
      toolVersion: "1.0.0",
      config: { method: "GET", url: FIXTURE_HTTP_URL },
      input: { source: "workflow_input" },
    },
    {
      id: aiExtractNodeId,
      toolId: "builtin.json.extract",
      toolVersion: "1.0.0",
      config: { path: "answer" },
      input: { source: "node_output", nodeId: aiHttpNodeId, outputIndex: 0 },
    },
    {
      id: aiNodeId,
      toolId: "builtin.ai.complete",
      toolVersion: "1.0.0",
      config: {
        providerId: "mock",
        model: "smoke-model",
        prompt: "Summarize the answer:",
        secretRef: "secret://vault/e2e-ai",
      },
      input: { source: "node_output", nodeId: aiExtractNodeId, outputIndex: 0 },
    },
  ],
  edges: [
    { from: aiHttpNodeId, to: aiExtractNodeId },
    { from: aiExtractNodeId, to: aiNodeId },
  ],
};
await expectJson(
  await fetch(api(`/projects/${projectId}/workflows`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ definition: aiWorkflow }),
  }),
  201,
  "AI workflow save",
);
const enqueuedAi = await expectJson(
  await fetch(
    api(`/projects/${projectId}/workflows/${aiWorkflowId}/executions`),
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        input: workflowEnvelope("json", {}, "application/json"),
      }),
    },
  ),
  202,
  "workflow run (HTTP -> JSON -> AI)",
);
const aiCompleted = await pollExecution(
  cookie,
  projectId,
  enqueuedAi.executionId,
  "HTTP -> JSON -> AI execution",
);
if (aiCompleted.execution.status !== "completed") {
  throw new Error(
    `HTTP -> JSON -> AI execution ended as ${aiCompleted.execution.status}: ${JSON.stringify(aiCompleted.execution.error ?? {})}`,
  );
}
const aiSteps = aiCompleted.steps ?? [];
const aiStep = aiSteps.find((step) => step.toolId === "builtin.ai.complete");
const aiOutput = aiStep?.outputContexts?.[0];
if (
  aiStep?.toolVersion !== "1.0.0" ||
  aiOutput?.type !== "ai_response" ||
  typeof aiOutput?.payload?.text !== "string" ||
  !aiOutput.payload.text.startsWith("mock:smoke-model:")
) {
  throw new Error(
    `AI step did not return the deterministic mock text: ${JSON.stringify(aiOutput?.payload ?? null)}`,
  );
}
const aiUsage = aiOutput.payload.usage ?? {};
if (
  typeof aiUsage.totalTokens !== "number" ||
  aiUsage.totalTokens <= 0 ||
  aiUsage.totalTokens !== aiUsage.promptTokens + aiUsage.completionTokens
) {
  throw new Error(
    `AI receipt usage is not totaled: ${JSON.stringify(aiUsage)}`,
  );
}
if (
  aiCompleted.execution.usage?.totalTokens !== aiUsage.totalTokens ||
  !aiCompleted.receipt ||
  aiCompleted.receipt.status !== "completed" ||
  !aiCompleted.receipt.outputContextIds?.includes(aiOutput.id) ||
  !Array.isArray(aiCompleted.receipt.provenance) ||
  aiCompleted.receipt.provenance.length < 3
) {
  throw new Error("AI execution receipt is missing usage/outputs/provenance");
}
const aiText = JSON.stringify(aiCompleted);
if (
  aiText.includes(aiKeyCanary) ||
  aiText.includes(secretCanary) ||
  /uw_session|password/i.test(aiText)
) {
  throw new Error("AI execution view contains credential material");
}

// Unknown providers fail closed with a structured code, without a retry storm.
const badProviderNodeId = randomUUID();
const badProviderWorkflowId = randomUUID();
await expectJson(
  await fetch(api(`/projects/${projectId}/workflows`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      definition: {
        id: badProviderWorkflowId,
        projectId,
        name: "Phase 4 Smoke Bad Provider",
        schemaVersion: 1,
        nodes: [
          {
            id: badProviderNodeId,
            toolId: "builtin.ai.complete",
            toolVersion: "1.0.0",
            config: {
              providerId: "nope",
              model: "smoke-model",
              prompt: "Summarize:",
              secretRef: "secret://vault/e2e-ai",
            },
            input: { source: "workflow_input" },
            retry: { maxAttempts: 5, backoffMs: 0 },
            idempotencyKey: "phase4-smoke-bad-provider",
          },
        ],
        edges: [],
      },
    }),
  }),
  201,
  "bad provider workflow save",
);
const enqueuedBad = await expectJson(
  await fetch(
    api(`/projects/${projectId}/workflows/${badProviderWorkflowId}/executions`),
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        input: workflowEnvelope("text", "hi", "text/plain"),
      }),
    },
  ),
  202,
  "bad provider workflow run",
);
const badView = await pollExecution(
  cookie,
  projectId,
  enqueuedBad.executionId,
  "bad provider execution",
);
if (
  badView.execution.status !== "failed" ||
  badView.steps?.length !== 1 ||
  badView.steps[0]?.error?.code !== "INVALID_CONFIG"
) {
  throw new Error(
    `unknown provider did not fail closed: ${JSON.stringify(badView.execution?.error ?? badView.steps?.[0]?.error ?? null)}`,
  );
}

const savedNote = await expectJson(
  await fetch(api(`/projects/${projectId}/documents/from-execution`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      executionId: enqueuedAi.executionId,
      outputContextId: aiOutput.id,
    }),
  }),
  201,
  "save AI output as note",
);
const savedNoteId = savedNote.document?.document?.id;
if (typeof savedNoteId !== "string") {
  throw new Error("AI note save did not return a document id");
}
const savedAiArtifact = await expectJson(
  await fetch(api(`/projects/${projectId}/artifacts/from-execution`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      executionId: enqueuedAi.executionId,
      outputContextId: aiOutput.id,
    }),
  }),
  201,
  "save AI output as artifact",
);
if (typeof savedAiArtifact.artifact?.id !== "string") {
  throw new Error("AI artifact save did not return an artifact id");
}

// Fresh login session (second-device equivalent) reads the note back and
// pulls the sync change carrying the Note op.
const freshLogin = await fetch(api("/auth/login"), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password: secretCanary }),
});
await expectJson(freshLogin, 200, "fresh session login");
const freshCookie = sessionCookie(freshLogin);
const freshDocuments = await expectJson(
  await fetch(api(`/projects/${projectId}/documents`), {
    headers: { cookie: freshCookie },
  }),
  200,
  "fresh session document list",
);
if (
  !freshDocuments.documents?.some((document) => document?.id === savedNoteId)
) {
  throw new Error("fresh session document list is missing the AI note");
}
const freshNote = await expectJson(
  await fetch(api(`/projects/${projectId}/documents/${savedNoteId}`), {
    headers: { cookie: freshCookie },
  }),
  200,
  "fresh session note read",
);
if (freshNote.revision?.content?.body !== aiOutput.payload.text) {
  throw new Error("fresh session note body does not match the AI output");
}
const notePull = await syncChanges(freshCookie, "0");
const noteOp = notePull.find(
  (change) =>
    change?.entityType === "document" && change?.entityId === savedNoteId,
);
if (!noteOp || noteOp.kind !== "upsert" || !noteOp.payload?.note) {
  throw new Error("sync pull is missing the Note op for the AI note");
}
const pullText = JSON.stringify(notePull);
if (
  pullText.includes(aiKeyCanary) ||
  pullText.includes(secretCanary) ||
  /uw_session|password/i.test(pullText)
) {
  throw new Error("sync pull payload contains credential material");
}

console.log("docker Phase 4 AI smoke passed");

const logoutResponse = await fetch(api("/auth/logout"), {
  method: "POST",
  headers: { cookie },
});
if (logoutResponse.status !== 204) {
  throw new Error(`logout returned HTTP ${logoutResponse.status}`);
}

const protectedBody = await expectJson(
  await fetch(api("/sync/devices"), { headers: { cookie } }),
  401,
  "post-logout sync route",
);
if (protectedBody.error?.code !== "UNAUTHORIZED") {
  throw new Error("post-logout sync route did not return UNAUTHORIZED");
}

console.log("docker Phase 2 sync smoke passed");
