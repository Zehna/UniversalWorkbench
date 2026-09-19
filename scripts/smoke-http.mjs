import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8080";
const maxAttempts = Number(process.env.SMOKE_MAX_ATTEMPTS ?? "30");
const retryDelayMs = Number(process.env.SMOKE_RETRY_DELAY_MS ?? "1000");
const secretCanary =
  process.env.SMOKE_SECRET_CANARY ??
  `phase2-smoke-${randomBytes(24).toString("base64url")}`;

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
    await fetch(api(`/sync/changes?cursor=${encodeURIComponent(cursor)}&limit=500`), {
      headers: { cookie },
    }),
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
