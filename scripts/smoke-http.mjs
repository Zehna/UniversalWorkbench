import { randomBytes } from "node:crypto";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8080";
const maxAttempts = Number(process.env.SMOKE_MAX_ATTEMPTS ?? "30");
const retryDelayMs = Number(process.env.SMOKE_RETRY_DELAY_MS ?? "1000");

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
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs);
      }
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
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  return body;
}

function sessionCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  const cookie = setCookie?.split(";", 1)[0];
  if (!cookie) {
    throw new Error("owner setup did not return a session cookie");
  }
  return cookie;
}

const api = (path) => `${baseUrl}/api${path}`;

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

const setupStatus = await expectJson(
  await fetch(api("/setup/status")),
  200,
  "setup status",
);
if (setupStatus.initialized !== false) {
  throw new Error("fresh deployment is already initialized");
}

const username = `smoke-${randomBytes(6).toString("hex")}`;
const password = `smoke-${randomBytes(24).toString("base64url")}`;

const setupResponse = await fetch(api("/setup/owner"), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password }),
});
const setupBody = await expectJson(setupResponse, 201, "owner setup");
if (setupBody.owner?.username !== username) {
  throw new Error("owner setup returned the wrong owner");
}
const cookie = sessionCookie(setupResponse);

const projectBody = await expectJson(
  await fetch(api("/projects"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify({ name: "Smoke project" }),
  }),
  201,
  "project creation",
);
const projectId = projectBody.project?.id;
if (typeof projectId !== "string") {
  throw new Error("project creation did not return an id");
}

const createdNote = await expectJson(
  await fetch(api(`/projects/${projectId}/documents`), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify({
      title: "Smoke note",
      body: "revision one",
    }),
  }),
  201,
  "note creation",
);
const documentId = createdNote.document?.id;
const firstRevisionId = createdNote.revision?.id;
if (typeof documentId !== "string" || typeof firstRevisionId !== "string") {
  throw new Error("note creation did not return document and revision ids");
}

const updatedNote = await expectJson(
  await fetch(api(`/projects/${projectId}/documents/${documentId}`), {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify({
      title: "Smoke note",
      body: "revision two",
      baseRevisionId: firstRevisionId,
    }),
  }),
  200,
  "note update",
);
const secondRevisionId = updatedNote.revision?.id;
if (
  typeof secondRevisionId !== "string" ||
  secondRevisionId === firstRevisionId
) {
  throw new Error("note update did not advance the revision");
}

const revisions = await expectJson(
  await fetch(
    api(`/projects/${projectId}/documents/${documentId}/revisions`),
    { headers: { cookie } },
  ),
  200,
  "revision listing",
);
if (!Array.isArray(revisions.revisions) || revisions.revisions.length !== 2) {
  throw new Error("revision listing did not contain exactly two revisions");
}

const staleResponse = await fetch(
  api(`/projects/${projectId}/documents/${documentId}`),
  {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify({
      title: "Smoke note",
      body: "stale revision",
      baseRevisionId: firstRevisionId,
    }),
  },
);
const staleBody = await expectJson(staleResponse, 409, "stale note update");
if (staleBody.error?.code !== "REVISION_CONFLICT") {
  throw new Error("stale note update did not return REVISION_CONFLICT");
}

const logoutResponse = await fetch(api("/auth/logout"), {
  method: "POST",
  headers: { cookie },
});
if (logoutResponse.status !== 204) {
  throw new Error(`logout returned HTTP ${logoutResponse.status}`);
}

const protectedResponse = await fetch(api("/projects"), {
  headers: { cookie },
});
const protectedBody = await expectJson(
  protectedResponse,
  401,
  "post-logout protected route",
);
if (protectedBody.error?.code !== "UNAUTHORIZED") {
  throw new Error("post-logout protected route did not return UNAUTHORIZED");
}

console.log("docker Phase 1 HTTP smoke passed");
