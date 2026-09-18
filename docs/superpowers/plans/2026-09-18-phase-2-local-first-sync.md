# Phase 2 Local-First & Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add trustworthy local-first project/note state, durable offline operations, device identity, HTTP/WebSocket synchronization, conflict preservation, and tombstones on top of the Phase 1 owner/data core.

**Architecture:** Browser state is stored through a `LocalStore` abstraction. Preferred persistence is SQLite WASM in a dedicated Worker using OPFS; an IndexedDB implementation persists the essential subset when OPFS/cross-origin isolation is unavailable. Every local mutation atomically updates local canonical state and appends a pending operation. The server remains canonical for durable shared state, stores devices/operations/cursors/tombstones in PostgreSQL, applies idempotent operations through the Action Layer, exposes HTTP catch-up/recovery, and uses WebSocket only as the realtime transport.

**Tech Stack:** Node.js 24 LTS, TypeScript, React 19.3, Vite 8.1, Express 5.2, PostgreSQL 17, Drizzle ORM, `@sqlite.org/sqlite-wasm@3.53.4-build1`, browser native WebSocket, `ws@8.21.3` server-side, `@playwright/test@1.63.0` for real-browser OPFS/reconnect tests.

**Spec:** `docs/superpowers/specs/2026-09-15-universal-workbench-design.md`

## Global Constraints

- Preserve the approved model: `local state + operation journal + server revision state`.
- WebSocket is transport, never durability; HTTP recovery must remain sufficient to catch up.
- Local writes commit locally first and append a pending operation in the same local transaction.
- Operation IDs are globally unique UUIDs and server ingestion is idempotent.
- Content conflicts preserve both versions; important content never uses silent last-write-wins.
- Deletion uses tombstones so offline clients cannot resurrect deleted entities.
- Secrets, cookies, password hashes, and raw session tokens never enter operation payloads, diagnostics exports, or browser local sync tables.
- Phase 2 implements Project and Note sync plus Artifact metadata catch-up; Artifact binary upload/download policy remains metadata-first and on-demand.
- Phase 3 tool/workflow execution, AI, MCP, provider secrets, and arbitrary upload hardening are out of scope.
- OPFS uses a dedicated Worker. Deployment must emit `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`; fallback persistence is IndexedDB when OPFS cannot be initialized.
- Browser tests use real Chromium through Playwright; Node/jsdom tests are not accepted as proof of OPFS behavior.
- PostgreSQL migrations remain explicit and fail loudly before app start.
- Every task ends with fresh tests and a commit before the next task begins.

---

### Task 1: Sync contracts and package boundary

**Files:**

- Create: `packages/contracts/src/sync.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/sync/package.json`
- Create: `packages/sync/tsconfig.json`
- Create: `packages/sync/src/model.ts`
- Create: `packages/sync/src/index.ts`
- Create: `packages/sync/test/contracts.test.ts`
- Modify: `scripts/verify-workspaces.mjs`
- Modify: `package.json`

**Interfaces:**

- Produces:

```ts
type SyncEntityType = "project" | "document" | "artifact";
type SyncAction =
  | "project.create"
  | "project.update"
  | "project.delete"
  | "document.create"
  | "document.update"
  | "document.delete";

interface SyncOperation {
  id: string;
  deviceId: string;
  projectId: string | null;
  entityType: SyncEntityType;
  entityId: string;
  action: SyncAction;
  baseRevision: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface SyncChange {
  cursor: string;
  operationId: string;
  entityType: SyncEntityType;
  entityId: string;
  kind: "upsert" | "tombstone" | "conflict";
  revision: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

type ClientSyncMessage =
  | { type: "HELLO"; deviceId: string; cursor: string }
  | { type: "SYNC_REQUEST"; cursor: string }
  | { type: "PUSH_OPERATION"; operation: SyncOperation }
  | { type: "PING"; nonce: string };

type ServerSyncMessage =
  | { type: "READY"; deviceId: string; cursor: string }
  | {
      type: "ACK_OPERATION";
      operationId: string;
      cursor: string;
      revision: string | null;
    }
  | { type: "REMOTE_OPERATION"; change: SyncChange }
  | { type: "CONFLICT"; operationId: string; change: SyncChange }
  | { type: "PONG"; nonce: string }
  | { type: "ERROR"; code: string; message: string };
```

- [ ] **Step 1: Write failing contract tests**

```ts
it("rejects a sync operation without a device ID", () => {
  expect(() =>
    SyncOperationSchema.parse({
      id: crypto.randomUUID(),
      deviceId: "",
      projectId: null,
      entityType: "project",
      entityId: crypto.randomUUID(),
      action: "project.create",
      baseRevision: null,
      payload: { name: "Offline project" },
      createdAt: new Date().toISOString(),
    }),
  ).toThrow();
});

it("round-trips every WebSocket message through the discriminated union", () => {
  const message = {
    type: "PUSH_OPERATION",
    operation: validOperation(),
  };
  expect(ClientSyncMessageSchema.parse(message)).toEqual(message);
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test -w @uw/contracts`

Expected: FAIL because the sync schemas/exports do not exist.

- [ ] **Step 3: Implement contracts and package skeleton**

Use Zod discriminated unions. `cursor` is a decimal string so browser JSON never depends on JavaScript bigint precision. Payloads are records and are action-validated again by the server apply engine.

- [ ] **Step 4: Run GREEN**

Run:

```bash
npm run typecheck -w @uw/contracts
npm run test -w @uw/contracts
npm run typecheck -w @uw/sync
npm run test -w @uw/sync
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts packages/sync scripts/verify-workspaces.mjs package.json package-lock.json
git commit -m "feat: define phase 2 sync contracts"
```

---

### Task 2: PostgreSQL device, operation, cursor, and tombstone schema

**Files:**

- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/index.ts`
- Create: `packages/database/src/repositories/sync.ts`
- Create: `packages/database/test/sync-schema.integration.test.ts`
- Generate: `packages/database/drizzle/0001_phase2_sync.sql`
- Generate: `packages/database/drizzle/meta/_journal.json`
- Generate: `packages/database/drizzle/meta/0001_snapshot.json`

**Interfaces:**

```ts
interface SyncRepository {
  registerDevice(input: {
    id: string;
    ownerId: string;
    name: string;
    now: Date;
  }): Promise<DeviceRecord>;

  getDevice(ownerId: string, deviceId: string): Promise<DeviceRecord | null>;
  touchDevice(ownerId: string, deviceId: string, now: Date): Promise<void>;
  revokeDevice(ownerId: string, deviceId: string, now: Date): Promise<void>;

  findOperation(
    ownerId: string,
    operationId: string,
  ): Promise<StoredSyncOperation | null>;
  persistAppliedOperation(
    input: PersistAppliedOperationInput,
  ): Promise<SyncChange>;
  persistConflict(input: PersistConflictInput): Promise<SyncChange>;
  listChanges(
    ownerId: string,
    afterCursor: string,
    limit: number,
  ): Promise<SyncChange[]>;
  getLatestCursor(ownerId: string): Promise<string>;
}
```

Server tables:

- `sync_devices(id, owner_id, name, created_at, last_seen_at, revoked_at)`
- `sync_operations(id, owner_id, device_id, project_id, entity_type, entity_id, action, base_revision, payload, outcome, result_revision, created_at)`
- `sync_changes(cursor BIGSERIAL, owner_id, operation_id UNIQUE, entity_type, entity_id, kind, revision, payload, created_at)`
- `sync_tombstones(owner_id, entity_type, entity_id, project_id, operation_id, cursor, deleted_at)`

- [ ] **Step 1: Write failing PostgreSQL tests**

```ts
it("deduplicates operations by owner + operation ID", async () => {
  const first = await repository.persistAppliedOperation(appliedInput());
  const second = await repository.persistAppliedOperation(appliedInput());
  expect(second.cursor).toBe(first.cursor);
});

it("returns strictly increasing owner cursors", async () => {
  const a = await repository.persistAppliedOperation(appliedInput());
  const b = await repository.persistAppliedOperation(
    appliedInput({ id: crypto.randomUUID() }),
  );
  expect(BigInt(b.cursor)).toBeGreaterThan(BigInt(a.cursor));
});

it("marks revoked devices and prevents them being treated as active", async () => {
  await repository.revokeDevice(ownerId, deviceId, now);
  expect(
    (await repository.getDevice(ownerId, deviceId))?.revokedAt,
  ).not.toBeNull();
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test -w @uw/database -- sync-schema.integration.test.ts`

Expected: FAIL because the Phase 2 tables/repository are missing.

- [ ] **Step 3: Add Drizzle schema and generate migration**

Run:

```bash
npm run drizzle:generate -w @uw/database
```

Review generated SQL. The migration must be additive; no destructive rewrite of Phase 1 tables.

- [ ] **Step 4: Implement repository with idempotent transactions**

`persistAppliedOperation` and `persistConflict` must use one PostgreSQL transaction. Repeated operation IDs return the existing change instead of creating another cursor.

- [ ] **Step 5: Run migration/integration GREEN twice**

Run:

```bash
npm run test -w @uw/database -- sync-schema.integration.test.ts
npm run test -w @uw/database -- sync-schema.integration.test.ts
```

Expected: PASS both times on freshly reset test schemas.

- [ ] **Step 6: Commit**

```bash
git add packages/database
git commit -m "feat: add durable sync persistence"
```

---

### Task 3: Browser LocalStore and SQLite WASM/OPFS backend

**Files:**

- Create: `apps/web/src/local/store.ts`
- Create: `apps/web/src/local/schema.ts`
- Create: `apps/web/src/local/sqlite-worker.ts`
- Create: `apps/web/src/local/sqlite-store.ts`
- Create: `apps/web/src/local/open-local-store.ts`
- Modify: `apps/web/package.json`
- Modify: `apps/web/vite.config.ts`
- Modify: `deploy/docker/nginx.conf`
- Create: `apps/web/e2e/local-opfs.spec.ts`
- Create: `playwright.config.ts`
- Modify: `package.json`

**Interfaces:**

```ts
interface LocalStore {
  transaction<T>(fn: (tx: LocalTransaction) => Promise<T>): Promise<T>;
  getDevice(): Promise<LocalDeviceRecord | null>;
  setDevice(device: LocalDeviceRecord): Promise<void>;
  getCursor(): Promise<string>;
  setCursor(cursor: string): Promise<void>;
  listPendingOperations(limit: number): Promise<SyncOperation[]>;
  markOperationAcked(operationId: string, cursor: string): Promise<void>;
  applyRemoteChange(change: SyncChange): Promise<void>;
  listConflicts(): Promise<LocalConflictRecord[]>;
  close(): Promise<void>;
}

interface LocalTransaction {
  upsertProject(project: Project): Promise<void>;
  upsertNote(note: NoteDocumentView): Promise<void>;
  putTombstone(tombstone: LocalTombstone): Promise<void>;
  appendOperation(operation: SyncOperation): Promise<void>;
}
```

SQLite local tables:
`local_meta`, `projects`, `documents`, `document_revisions`, `artifacts`, `pending_operations`, `conflicts`, `tombstones`.

- [ ] **Step 1: Add real-browser RED test**

```ts
test("persists local project state across page reload using OPFS", async ({
  page,
}) => {
  await page.goto("/__phase2-test");
  await page.evaluate(() => window.__phase2.createProjectOffline("Offline"));
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => window.__phase2.projectNames()))
    .toContain("Offline");
});
```

- [ ] **Step 2: Install exact browser persistence/test dependencies**

```bash
npm install -w @uw/web @sqlite.org/sqlite-wasm@3.53.4-build1
npm install -D @playwright/test@1.63.0
npx playwright install chromium --with-deps
```

- [ ] **Step 3: Implement Worker-backed SQLite OPFS store**

The worker owns the connection for its lifetime and executes each mutation transaction completely inside one worker request. Do not expose raw SQL to React components.

- [ ] **Step 4: Emit COOP/COEP in dev and Docker web servers**

Vite dev headers and Nginx responses must include:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

- [ ] **Step 5: Run real Chromium GREEN**

Run:

```bash
npm run build -w @uw/web
npx playwright test apps/web/e2e/local-opfs.spec.ts --project=chromium
```

Expected: OPFS backend selected and data survives reload.

- [ ] **Step 6: Commit**

```bash
git add apps/web deploy/docker/nginx.conf playwright.config.ts package.json package-lock.json
git commit -m "feat: add browser sqlite opfs local store"
```

---

### Task 4: IndexedDB fallback and atomic local mutation journal

**Files:**

- Create: `apps/web/src/local/indexeddb-store.ts`
- Create: `apps/web/src/local/mutations.ts`
- Create: `apps/web/test/local-mutations.test.ts`
- Modify: `apps/web/src/local/open-local-store.ts`

**Interfaces:**

```ts
createProjectLocally(store, device, input): Promise<Project>
updateProjectLocally(store, device, project, input): Promise<Project>
createNoteLocally(store, device, projectId, input): Promise<NoteDocumentView>
updateNoteLocally(store, device, view, input): Promise<NoteDocumentView>
```

Every function must perform canonical local state change + `pending_operations` append in one `LocalStore.transaction()`.

- [ ] **Step 1: Write RED atomicity tests**

```ts
it("does not keep a local project if operation append fails", async () => {
  const store = failingStore({ failOnAppend: true });
  await expect(
    createProjectLocally(store, device, { name: "A" }),
  ).rejects.toThrow();
  expect(await store.listProjects()).toEqual([]);
});

it("creates stable local IDs that are referenced by its pending operation", async () => {
  const project = await createProjectLocally(store, device, {
    name: "Offline",
  });
  const [op] = await store.listPendingOperations(10);
  expect(op.entityId).toBe(project.id);
});
```

- [ ] **Step 2: Implement IndexedDB fallback**

Use one database version and one readwrite transaction spanning essential object stores. Store only structured clone-safe data; no raw secret/session values.

- [ ] **Step 3: Implement local mutation functions**

Use UUIDs locally. Note update operations carry the current `revision.id` as `baseRevision`.

- [ ] **Step 4: Run GREEN**

Run:

```bash
npm run test -w @uw/web -- local-mutations.test.ts
npm run typecheck -w @uw/web
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/local apps/web/test/local-mutations.test.ts
git commit -m "feat: add atomic offline mutation journal"
```

---

### Task 5: Device registration, revocation, and HTTP recovery API

**Files:**

- Create: `packages/sync/src/service.ts`
- Modify: `packages/sync/src/index.ts`
- Create: `apps/server/src/routes/sync.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/composition.ts`
- Modify: `apps/server/package.json`
- Create: `apps/server/test/sync-http.integration.test.ts`

**Routes:**

- `POST /sync/devices` — register current browser device.
- `GET /sync/devices` — list owner devices.
- `DELETE /sync/devices/:deviceId` — revoke a device.
- `GET /sync/changes?cursor=<decimal>&limit=<1..500>` — catch up.
- `POST /sync/operations` — idempotently ingest a bounded batch.

- [ ] **Step 1: Write RED auth/revocation/recovery tests**

```ts
it("conceals sync data from unauthenticated callers", async () => {
  expect((await request(app).get("/sync/changes?cursor=0")).status).toBe(401);
});

it("rejects operations from a revoked device", async () => {
  await repository.revokeDevice(ownerId, deviceId, now);
  const response = await authed(agent)
    .post("/sync/operations")
    .send({ operations: [operationFor(deviceId)] });
  expect(response.status).toBe(403);
});

it("returns changes strictly after the supplied cursor", async () => {
  const response = await authed(agent).get("/sync/changes?cursor=1");
  expect(
    response.body.changes.every((c: SyncChange) => BigInt(c.cursor) > 1n),
  ).toBe(true);
});
```

- [ ] **Step 2: Implement device service and HTTP router**

All routes derive owner identity from the authenticated session. The client never supplies owner ID.

- [ ] **Step 3: Bound payloads**

Maximum operation batch: 100. Maximum catch-up limit: 500. Reject unknown action/entity combinations before repository mutation.

- [ ] **Step 4: Run GREEN**

Run: `npm run test -w @uw/server -- sync-http.integration.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/sync apps/server package.json package-lock.json
git commit -m "feat: add device and sync recovery api"
```

---

### Task 6: Server operation apply engine, conflicts, and tombstones

**Files:**

- Create: `packages/sync/src/apply.ts`
- Create: `packages/sync/src/conflict.ts`
- Create: `packages/sync/test/apply.test.ts`
- Modify: `packages/database/src/repositories/projects.ts`
- Modify: `packages/database/src/repositories/documents.ts`
- Modify: `packages/database/src/schema.ts`
- Generate: `packages/database/drizzle/0002_phase2_entity_sync_revision.sql`
- Create: `packages/database/test/sync-apply.integration.test.ts`

**Rules:**

- Project rows gain monotonically increasing `sync_revision BIGINT NOT NULL DEFAULT 0`.
- Note conflict token is the current document revision ID.
- Artifact metadata is server-to-client create-only in Phase 2.
- Project/document delete creates a tombstone and prevents an older offline operation from recreating the entity.
- A conflicting document update creates a `conflict` change containing both the incoming payload and current canonical summary; canonical note content is not overwritten.

- [ ] **Step 1: Write RED apply tests**

```ts
it("ACKs the same operation ID without applying twice", async () => {
  const first = await applyOperation(ctx, operation);
  const second = await applyOperation(ctx, operation);
  expect(second).toEqual(first);
  expect(await countProjectRows(operation.entityId)).toBe(1);
});

it("preserves both note versions on stale base revision", async () => {
  const result = await applyOperation(ctx, staleNoteUpdate());
  expect(result.kind).toBe("conflict");
  expect(result.payload).toMatchObject({
    incoming: expect.any(Object),
    current: expect.any(Object),
  });
  expect(await currentBody()).toBe("server body");
});

it("does not resurrect an entity after its tombstone cursor", async () => {
  await applyOperation(ctx, deleteProjectOperation());
  const result = await applyOperation(ctx, olderOfflineUpdate());
  expect(result.kind).toBe("conflict");
  expect(await tombstoneExists(projectId)).toBe(true);
});
```

- [ ] **Step 2: Implement through Action Layer**

The sync apply engine may call repositories directly only inside `executeAction()` authorization/run/audit stages. It must never bypass auditing for accepted state changes.

- [ ] **Step 3: Add sync revision migration and repository CAS methods**

Project update is `WHERE id = ... AND sync_revision = baseRevision`, increments by one, and returns the new revision token.

- [ ] **Step 4: Run GREEN twice against PostgreSQL**

Run:

```bash
npm run test -w @uw/sync
npm run test -w @uw/database -- sync-apply.integration.test.ts
npm run test -w @uw/database -- sync-apply.integration.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/sync packages/database
git commit -m "feat: add conflict-safe sync apply engine"
```

---

### Task 7: Durable WebSocket transport with ACK/cursor recovery

**Files:**

- Create: `apps/server/src/sync/websocket.ts`
- Create: `apps/server/src/sync/session.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/composition.ts`
- Modify: `apps/server/package.json`
- Create: `apps/server/test/sync-websocket.integration.test.ts`

**Interfaces:**

```ts
attachSyncWebSocketServer(input: {
  httpServer: Server;
  authService: AuthService;
  syncService: SyncService;
  cookieName: string;
  allowedOrigins: string[];
}): WebSocketServer;
```

- [ ] **Step 1: Write RED WS tests**

Tests use `ws` as a Node test client:

- unauthenticated upgrade rejected;
- wrong Origin rejected;
- revoked device receives ERROR then close;
- duplicate PUSH_OPERATION returns the same ACK cursor;
- reconnect HELLO with old cursor streams missed REMOTE_OPERATION messages;
- malformed/oversized messages close with a policy error.

- [ ] **Step 2: Install exact server dependency**

```bash
npm install -w @uw/server ws@8.21.3
npm install -D -w @uw/server @types/ws@8.18.1
```

- [ ] **Step 3: Implement session-cookie authenticated upgrade**

Use the existing session cookie parser. Do not accept bearer credentials in URL query strings.

- [ ] **Step 4: Implement protocol ordering**

On HELLO:

1. validate active device;
2. send READY with current cursor;
3. stream changes after client cursor in ascending cursor order.

On PUSH_OPERATION:

1. validate message;
2. apply idempotently;
3. persist before sending ACK/CONFLICT;
4. broadcast accepted change to other owner sockets.

- [ ] **Step 5: Run GREEN**

Run: `npm run test -w @uw/server -- sync-websocket.integration.test.ts`

- [ ] **Step 6: Commit**

```bash
git add apps/server package-lock.json
git commit -m "feat: add durable websocket sync transport"
```

---

### Task 8: Browser sync coordinator and explicit sync status UX

**Files:**

- Create: `apps/web/src/sync/client.ts`
- Create: `apps/web/src/sync/coordinator.ts`
- Create: `apps/web/src/sync/status.ts`
- Create: `apps/web/src/sync/SyncStatus.tsx`
- Create: `apps/web/src/sync/ConflictList.tsx`
- Modify: `apps/web/src/auth/AuthGate.tsx`
- Modify: `apps/web/src/projects/ProjectList.tsx`
- Modify: `apps/web/src/projects/ProjectWorkspace.tsx`
- Modify: `apps/web/src/documents/NoteEditor.tsx`
- Create: `apps/web/test/sync-coordinator.test.ts`

**State:**

```ts
type SyncStatus =
  | { state: "local-only" }
  | { state: "offline"; pending: number }
  | { state: "syncing"; pending: number }
  | { state: "synced"; cursor: string }
  | { state: "conflict"; pending: number; conflicts: number };
```

- [ ] **Step 1: Write RED coordinator tests**

```ts
it("keeps a local save successful when the network is offline", async () => {
  network.fail();
  const note = await coordinator.updateNote(input);
  expect(note.revision.content.body).toBe("offline edit");
  expect(coordinator.status()).toMatchObject({ state: "offline", pending: 1 });
});

it("does not delete local text when the server reports a conflict", async () => {
  await coordinator.handleServerMessage(conflictMessage());
  expect(await localStore.getNote(documentId)).toMatchObject({
    revision: { content: { body: "my offline edit" } },
  });
  expect((await localStore.listConflicts()).length).toBe(1);
});
```

- [ ] **Step 2: Implement startup flow**

After authenticated session:

1. open local store;
2. load/generate device identity;
3. register device over HTTP if not registered;
4. render local project/note data immediately;
5. connect WebSocket;
6. drain pending operations sequentially;
7. catch up by cursor over WS, with HTTP fallback on WS failure.

- [ ] **Step 3: Replace network-first project/note mutations**

The Phase 1 screens call coordinator methods. Successful offline mutations show `Saved locally`, not a generic network error.

- [ ] **Step 4: Add conflict and status UI**

Conflict list exposes current server summary + preserved local payload and a `Reload server version` action. Automatic merge of note body is forbidden.

- [ ] **Step 5: Run GREEN**

Run:

```bash
npm run test -w @uw/web
npm run typecheck -w @uw/web
npm run build -w @uw/web
```

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat: add local-first sync coordinator"
```

---

### Task 9: Multi-device, reconnect, fallback, and chaos browser tests

**Files:**

- Create: `apps/web/e2e/sync-two-device.spec.ts`
- Create: `apps/web/e2e/sync-offline-reconnect.spec.ts`
- Create: `apps/web/e2e/sync-indexeddb-fallback.spec.ts`
- Create: `apps/web/e2e/sync-conflict.spec.ts`
- Create: `scripts/start-e2e-stack.mjs`
- Modify: `playwright.config.ts`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Two-device RED test**

```ts
test("offline note edit syncs to a second device after reconnect", async ({
  browser,
}) => {
  const phone = await browser.newContext();
  const laptop = await browser.newContext();
  // both authenticate to the same test owner
  // phone edits while its WebSocket/HTTP sync is blocked
  // reconnect phone
  // laptop receives the new canonical revision
});
```

- [ ] **Step 2: Add deterministic network controls**

Tests may block `/api/sync/*` and WebSocket traffic but must keep local PWA assets available. No arbitrary sleeps; assert status transitions with `expect.poll`.

- [ ] **Step 3: Add fallback test**

Start PWA without cross-origin isolation or force OPFS capability probe false. Assert IndexedDB is selected and pending operations survive reload.

- [ ] **Step 4: Add conflict/tombstone tests**

- concurrent edits from two contexts preserve both versions;
- server delete + older offline update never resurrects entity;
- revoking device A prevents further push after reconnect;
- HTTP catch-up restores missed WS changes.

- [ ] **Step 5: Add CI browser job**

CI installs Chromium once:

```bash
npx playwright install chromium --with-deps
npm run e2e:sync
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/e2e scripts/start-e2e-stack.mjs playwright.config.ts .github/workflows/ci.yml package.json package-lock.json
git commit -m "test: verify multi-device local-first sync"
```

---

### Task 10: Phase 2 deployment, diagnostics, docs, and final gate

**Files:**

- Modify: `deploy/docker/nginx.conf`
- Modify: `deploy/docker/compose.yml` only if WebSocket proxy settings require it
- Modify: `scripts/smoke-http.mjs`
- Create: `docs/architecture/phase-2.md`
- Modify: `docs/runbooks/local-development.md`
- Modify: `README.md`
- Modify: `.github/workflows/ci.yml` only for permanent Phase 2 gates

**Diagnostics output (never secrets):**

```ts
interface SyncDiagnostics {
  deviceId: string;
  backend: "opfs-sqlite" | "indexeddb";
  cursor: string;
  pendingOperations: number;
  conflicts: number;
  websocketState: "closed" | "connecting" | "open";
  lastAckAt: string | null;
  lastErrorCode: string | null;
}
```

- [ ] **Step 1: Extend Docker smoke**

The canonical smoke must:

1. create owner;
2. register two devices;
3. push project create from device A;
4. recover it through `GET /sync/changes` for device B;
5. push note create/update;
6. replay the exact same operation ID and prove cursor does not advance;
7. push a stale note update and prove CONFLICT without canonical overwrite;
8. revoke device A and prove later push is rejected;
9. verify WebSocket catch-up for device B;
10. logout.

- [ ] **Step 2: Verify Nginx WebSocket + isolation headers**

`/api/sync/socket` must upgrade WebSocket correctly. Static/PWA responses must emit the COOP/COEP headers required by SQLite OPFS.

- [ ] **Step 3: Document architecture and fallback behavior**

`docs/architecture/phase-2.md` documents:

- local tables;
- operation lifecycle `pending -> sent -> acked/conflict`;
- cursor semantics;
- device registration/revocation;
- OPFS/IndexedDB selection;
- conflict/tombstone policy;
- HTTP recovery;
- WebSocket non-durability;
- diagnostics fields.

- [ ] **Step 4: Run the entire final gate from a clean checkout**

```text
npm ci                                         PASS
npm audit --omit=dev --audit-level=high        PASS
npm run verify:workspaces                      PASS
npm run format:check                           PASS
npm run lint                                   PASS
npm run typecheck                              PASS
npm test                                       PASS
npm run build                                  PASS
node scripts/verify-pwa.mjs                    PASS
PostgreSQL Phase 2 migration                   PASS
Sync repository/idempotency                    PASS
HTTP recovery/device revocation                PASS
WebSocket ACK/cursor/reconnect                  PASS
Real Chromium SQLite OPFS persistence          PASS
IndexedDB fallback persistence                 PASS
Two-device sync                                PASS
Offline reconnect                              PASS
Conflict preservation                          PASS
Tombstone no-resurrection                      PASS
Docker Phase 2 vertical smoke                  PASS
```

- [ ] **Step 5: Security verification**

Search test logs and persisted operation payloads to prove there is no plaintext password, raw session token, Cookie header, or secret value. Confirm every server sync mutation is authorized by session owner and active device.

- [ ] **Step 6: Open PR only after all gates pass**

PR title: `Phase 2: Local-First & Sync`.

- [ ] **Step 7: Commit**

```bash
git add README.md docs deploy scripts .github/workflows/ci.yml
git commit -m "docs: close phase 2 local-first sync"
```
