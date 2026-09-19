# Local Development Runbook

Universal Workbench Phase 2 supports local Node processes and the canonical Docker Compose deployment.

## Prerequisites

- Node.js 24.21.0
- npm supplied with Node.js
- PostgreSQL 17-compatible server for local-process development, or Docker Compose for the reference stack
- Chromium only when running the browser sync gate

After cloning, install exactly the locked dependency tree:

```bash
npm ci
```

## Path 1: Local Node processes + PostgreSQL

Provide an existing PostgreSQL database:

```text
postgresql://workbench:workbench@127.0.0.1:5432/workbench_test
```

Apply migrations explicitly before starting the API:

```bash
DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm run migrate -w @uw/database
```

Start the API:

```bash
DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test \
ARTIFACTS_DIR=./data/artifacts \
APP_MODE=all \
TRUSTED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173 \
npm run dev -w @uw/server
```

Start the PWA in another terminal:

```bash
npm run dev -w @uw/web
```

The Vite development server proxies `/api/*` to Express.

## Local-first backend selection

The PWA prefers SQLite WASM + OPFS when the browser provides the required capabilities and cross-origin isolation. If that path is unavailable, it falls back to IndexedDB.

Both backends persist:

- local projects and notes;
- pending sync operations;
- cursor;
- device identity;
- conflicts;
- tombstones.

A page reload does not discard pending offline edits.

## Sync transport

HTTP recovery endpoint:

```text
GET /api/sync/changes?cursor=<last-cursor>
```

WebSocket endpoint:

```text
ws://<host>/api/sync/socket
```

WebSocket is real-time transport only. HTTP cursor catch-up is the durable recovery mechanism.

## Diagnostics

The browser coordinator exposes:

- device ID;
- selected backend;
- durable cursor;
- pending operation count;
- conflict count;
- WebSocket state;
- last ACK timestamp;
- last sync error code.

Diagnostics intentionally exclude passwords, raw session tokens, Cookie headers, and secret values.

## Path 2: Canonical Docker Compose deployment

Create an environment file:

```bash
cp deploy/docker/.env.example deploy/docker/.env
```

Change the database password and keep `DATABASE_URL` consistent.

Start the reference stack:

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml up -d --build
```

Compose starts PostgreSQL, runs migrations once, starts the API, then starts the nginx/PWA container after the API is healthy.

Open:

```text
http://localhost:8080/
```

Reference endpoints:

```text
http://localhost:8080/api/health/live
http://localhost:8080/api/health/ready
ws://localhost:8080/api/sync/socket
```

The nginx layer emits COOP/COEP headers for OPFS SQLite and proxies the sync WebSocket upgrade separately from normal HTTP API traffic.

### Session cookie and HTTPS

Use `SESSION_COOKIE_SECURE=false` for local HTTP. Set it to `true` behind HTTPS.

### Stop or reset

Preserve data:

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml down
```

Delete PostgreSQL and artifact volumes intentionally:

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml down -v
```

Browser-local OPFS/IndexedDB data is independent of Docker volumes. Clearing browser site data removes that device's local workspace and device identity.

## Phase 2 quality gate

With PostgreSQL available:

```bash
npm audit --omit=dev --audit-level=high
npm run verify:workspaces
npm run format:check
npm run lint
npm run typecheck
TEST_DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm test
npm run build
node scripts/verify-pwa.mjs
```

Run the real-browser sync gate:

```bash
npx playwright install chromium --with-deps
TEST_DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm run e2e:sync
```

It verifies OPFS/IndexedDB persistence, multi-device catch-up, offline reconnect, conflict preservation, tombstone no-resurrection, and revoked-device rejection.

Run the canonical Docker Phase 2 vertical smoke:

```bash
docker compose -f deploy/docker/compose.yml up -d --build
SMOKE_SECRET_CANARY=phase2-local-canary node scripts/smoke-http.mjs
docker compose -f deploy/docker/compose.yml logs --no-color > phase2-docker.log
SMOKE_SECRET_CANARY=phase2-local-canary node scripts/verify-no-secrets.mjs phase2-docker.log
docker compose -f deploy/docker/compose.yml down -v
```

The smoke covers owner setup, two devices, project/note sync, HTTP recovery, idempotent replay, stale conflict preservation, revocation, WebSocket catch-up, isolation headers, credential-log scanning, and logout.
