# Local Development Runbook

Universal Workbench supports Phase 2 local-first synchronization and the Phase 3 Tool & Workflow Core on the development branch. Phase 3 Task 11 remains under final verification.

## Prerequisites

- Node.js 24.21.0
- npm supplied with Node.js
- PostgreSQL 17-compatible server for local-process development, or Docker Compose for the reference stack
- Chromium for the browser sync and workflow gates

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

## Phase 2 regression quality gate

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

Run the canonical Docker vertical smoke (Phase 2 sync plus Phase 3 workflow):

```bash
WORKBENCH_DOCKER_SMOKE_FIXTURE=1 docker compose -f deploy/docker/compose.yml up -d --build
WORKBENCH_DOCKER_SMOKE_FIXTURE=1 SMOKE_SECRET_CANARY=phase3-local-canary node scripts/smoke-http.mjs
docker compose -f deploy/docker/compose.yml logs --no-color > phase3-docker.log
SMOKE_SECRET_CANARY=phase3-local-canary node scripts/verify-no-secrets.mjs phase3-docker.log
docker compose -f deploy/docker/compose.yml down -v
```

The smoke covers owner setup, two devices, project/note sync, HTTP recovery, idempotent replay, stale conflict preservation, revocation, WebSocket catch-up, isolation headers, credential-log scanning, and logout. The Phase 3 section additionally covers the tool catalog, an `HTTP -> JSON extract` execution with receipt and provenance checks, saving the output as an Artifact, and the execution cancellation gate. `WORKBENCH_DOCKER_SMOKE_FIXTURE=1` enables only the deterministic injected-transport HTTP fixture (`https://fixture.workbench.dev/response`); it makes no external network connections. Never enable it in production deployments.

## Phase 3 — Tool & Workflow Core

The `phase-3-tools-workflow` branch adds a typed context compatibility bus,
version-pinned tools, DAG preflight, PostgreSQL-backed workflow definitions and
executions, a leased queue, an execution worker and a linear-first browser UI.
See [the architecture reference](../architecture/phase-3.md).

### Runtime modes

Set `APP_MODE` for the server process:

| Mode            | API and sync WebSocket | Workflow worker |
| --------------- | ---------------------- | --------------- |
| `all` (default) | Yes                    | Yes             |
| `api`           | Yes                    | No              |
| `worker`        | No                     | Yes             |

The worker requires an already-migrated PostgreSQL database. Important
settings: `WORKER_POLL_MS` (default 500), `WORKER_LEASE_MS` (default 60000) and `WORKER_RETRY_MS` (default 30000). A separate API and worker can
point to the same database. No Redis service is required.

For a local split-mode development session, run the existing migration command
above, then start each process in a separate terminal with the same
`DATABASE_URL`:

```bash
APP_MODE=api DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm run dev -w @uw/server
APP_MODE=worker DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm run dev -w @uw/server
```

In the reference Compose deployment, the `app` service uses `APP_MODE=all`
(API, sync WebSocket, and worker loop) while the `worker` service uses
`APP_MODE=worker` (queue polling only, no HTTP listener, no published ports).
Both share the PostgreSQL-backed leased queue, so either loop may claim
available work. The deployment smoke exercises workflow execution, receipts,
artifact handoff, and cancellation against this stack rather than treating
the Phase 2 sync smoke as sufficient.

### Workflow API and execution

Authenticated owner-scoped endpoints under `/api`:

- `GET /tools` lists pinned tool descriptors and server-granted permissions.
- `GET/POST /projects/:projectId/workflows` lists or saves definitions.
- `GET /projects/:projectId/workflows/:workflowId` reads a saved definition.
- `POST /projects/:projectId/workflows/:workflowId/executions` validates and queues a run.
- `GET /projects/:projectId/executions/:executionId` shows durable status, steps and receipt.
- `POST /projects/:projectId/executions/:executionId/cancel` requests cancellation.
- `POST /projects/:projectId/artifacts/from-execution` saves a completed
  output context as a JSON-serialized Artifact (512 KiB limit).

No endpoint accepts owner identity from client-provided JSON. The production
composition currently grants no workflow network permission by default:
workflows using `builtin.http.request` fail preflight until a trusted server
policy grants it. Never enable the test-only HTTP fixture in production.

### Phase 3 targeted checks

Run after installing dependencies and applying migrations to a test database:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test -w @uw/contracts
npm run test -w @uw/tools
npm run test -w @uw/workflow
npm run test -w @uw/execution
TEST_DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm test
npm run build
node scripts/verify-pwa.mjs
```

Run the dedicated workflow browser test with Chromium installed and an
available test PostgreSQL database:

```bash
npx playwright install chromium --with-deps
TEST_DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm run e2e:workflow
```

The browser fixture is enabled only by the test-mode E2E launcher, and the
equivalent Docker smoke fixture only by the explicit
`WORKBENCH_DOCKER_SMOKE_FIXTURE=1` flag. Neither must be used as evidence
that arbitrary production HTTP egress is authorized.

### Troubleshooting

- `MISSING_PERMISSION` at preflight: inspect server-granted permissions;
  editing user content or tool payloads cannot grant `network`.
- `INCOMPATIBLE_CONTEXT` or `INVALID_OUTPUT_INDEX`: check declared source
  types, output indexes, dependencies and exact tool versions.
- Execution remains `queued`: confirm a worker is running, the database
  migration succeeded and queue leases are being claimed.
- A reclaimed unsafe step fails with `UNCERTAIN_OUTCOME`: do not force replay;
  inspect the external side effect before scheduling a new operation.
- HTTP calls fail with `EGRESS_BLOCKED`: inspect the destination and DNS
  policy; do not disable private-address and redirect checks to pass tests.
- Browser workflow E2E fails while sync tests pass: inspect
  `apps/web/e2e/workflow-linear.spec.ts` and the job's Playwright artifacts
  before changing preflight or execution semantics.

### Phase 3 release gate

Task 11 must still establish the full golden workflow suite, Phase 3 Docker
vertical smoke (including execution receipts and cancellation), worker-mode
coverage and credential-leak checks. Require green Quality, Browser Sync,
Browser Workflow and Docker Smoke on the **same final commit** before opening
the Phase 3 pull request to `main`.
