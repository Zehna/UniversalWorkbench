# Local Development Runbook

Universal Workbench Phase 3 supports local-first browser authoring plus a durable server-side tool/workflow execution runtime.

## Prerequisites

- Node.js 24.21.0
- npm supplied with Node.js
- PostgreSQL 17-compatible server, or Docker Compose for the reference stack
- Chromium for browser gates

Install the locked tree:

```bash
npm ci
```

## Database

Example local test database:

```text
postgresql://workbench:workbench@127.0.0.1:5432/workbench_test
```

Apply migrations:

```bash
DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm run migrate -w @uw/database
```

## Runtime modes

### All-in-one

Runs API, sync WebSocket, and execution worker:

```bash
DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test \
ARTIFACTS_DIR=./data/artifacts \
APP_MODE=all \
TRUSTED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173 \
npm run dev -w @uw/server
```

### API only

Runs HTTP/WebSocket without draining the execution queue:

```bash
APP_MODE=api DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm run dev -w @uw/server
```

### Worker only

Runs the queue worker without opening an HTTP/WebSocket listener:

```bash
APP_MODE=worker DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm run dev -w @uw/server
```

Start the PWA separately:

```bash
npm run dev -w @uw/web
```

Vite proxies `/api/*` to the local Express server.

## Local-first authoring

Projects, notes, and workflow definitions are persisted through SQLite WASM + OPFS when available, with IndexedDB fallback.

Workflow execution is intentionally different from workflow authoring:

- authoring can be local/offline;
- running requires a synced canonical workflow revision;
- pending/conflicted/offline workflow revisions cannot run;
- the server repeats validation before enqueue.

## Built-in Phase 3 tools

```text
builtin.http.request@1
builtin.json.parse@1
builtin.json.select@1
builtin.text.template@1
builtin.note.write@1
```

Existing workflow revisions pin exact versions.

## Safe HTTP

The public HTTP tool permits only validated HTTP/HTTPS public egress.

It blocks private/loopback/link-local/metadata/reserved destinations, revalidates redirects, pins validated DNS addresses, rejects credential-bearing configuration, strips unsafe response headers, and bounds redirects, body size, and timeout.

There is no local/private-network bypass setting in Phase 3.

## Execution troubleshooting

Execution detail exposes:

- execution status;
- step status and attempt;
- pinned tool/version;
- sanitized error;
- output Context references.

Terminal execution receipt data includes immutable receipts and provenance.

If a workflow is stuck queued:

1. confirm `APP_MODE` is `all` or `worker`;
2. run `npm run verify:worker-mode` against a fresh test database;
3. inspect execution/step state through the protected execution API;
4. check PostgreSQL readiness and queue leases;
5. do not manually mutate queue rows in a normal recovery flow.

## Canonical Docker deployment

Prepare the environment:

```bash
cp deploy/docker/.env.example deploy/docker/.env
```

Start:

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml up -d --build
```

Open:

```text
http://localhost:8080/
```

The canonical profile uses `APP_MODE=all`.

The nginx layer retains the Phase 2 COOP/COEP requirements and sync WebSocket proxy.

## Stop/reset

Preserve server data:

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml down
```

Delete PostgreSQL and artifact volumes intentionally:

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml down -v
```

Browser OPFS/IndexedDB is independent of Docker volumes.

## Quality and security gate

With PostgreSQL available:

```bash
npm ci
npm audit --omit=dev --audit-level=high
npm run verify:workspaces
npm run format:check
npm run lint
npm run typecheck
TEST_DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm test
npm run build
node scripts/verify-pwa.mjs
```

Run Phase 2 sync regression:

```bash
npx playwright install chromium --with-deps
TEST_DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm run e2e:sync
```

Run Phase 3 workflow browser acceptance:

```bash
TEST_DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm run e2e:workflow
```

Verify worker-only process behavior:

```bash
TEST_DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm run verify:worker-mode
```

The worker verification expects a fresh/uninitialized test database because it deliberately performs first-run setup before handing the queued job from API mode to worker-only mode.

## Docker Phase 3 vertical smoke

```bash
docker compose -f deploy/docker/compose.yml up -d --build
SMOKE_SECRET_CANARY=phase3-local-canary node scripts/smoke-http.mjs
docker compose -f deploy/docker/compose.yml logs --no-color > phase3-docker.log
SMOKE_SECRET_CANARY=phase3-local-canary node scripts/verify-no-secrets.mjs phase3-docker.log
docker compose -f deploy/docker/compose.yml down -v
```

The smoke preserves all Phase 2 sync/security coverage and additionally creates a canonical workflow, runs `Text Template -> Note Write` through the real PostgreSQL queue/worker, verifies the generated note, receipts, provenance, and credential-free receipt payload.

HTTP is tested separately with injected deterministic transport plus the production safe-egress policy suite. The product does not weaken egress policy to make Docker tests reach a private fixture.
