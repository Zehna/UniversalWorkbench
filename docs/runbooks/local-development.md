# Local Development Runbook

Universal Workbench Phase 1 supports local Node processes and the canonical Docker Compose deployment.

## Prerequisites

- Node.js 24.21.0
- npm supplied with Node.js
- PostgreSQL 17-compatible server for local-process development, or Docker Compose for the reference stack

After cloning, install exactly the locked dependency tree:

```bash
npm ci
```

## Path 1: Local Node processes + PostgreSQL

Provide an existing PostgreSQL database. A development/test URL can look like:

```text
postgresql://workbench:workbench@127.0.0.1:5432/workbench_test
```

Apply migrations explicitly before starting the API:

```bash
DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm run migrate -w @uw/database
```

The API never silently applies schema changes during startup. A migration failure must be resolved before the application is started.

Start the API with a writable artifact directory:

```bash
DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test \
ARTIFACTS_DIR=./data/artifacts \
APP_MODE=all \
npm run dev -w @uw/server
```

Start the PWA in another terminal:

```bash
npm run dev -w @uw/web
```

Direct server health endpoints:

```text
http://localhost:3000/health/live
http://localhost:3000/health/ready
```

The Vite development server proxies `/api/*` to the Express server and removes the `/api` prefix.

`APP_MODE=worker` remains intentionally rejected until the durable worker/queue runtime is implemented.

## Path 2: Canonical Docker Compose deployment

Create an environment file first:

```bash
cp deploy/docker/.env.example deploy/docker/.env
```

Change the development database password in `deploy/docker/.env`, keeping `DATABASE_URL` consistent with the PostgreSQL values. If a password contains URI-reserved characters, URL-encode only the password component in `DATABASE_URL`.

Start the reference stack:

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml up -d --build
```

Compose starts PostgreSQL, waits for it to become healthy, runs the one-shot `migrate` service, and starts `app` only after migrations exit successfully. Migration failure blocks application startup instead of being hidden.

Phase 1 stores managed artifacts in the named Docker volume `artifacts-data`, mounted at `/app/data/artifacts`. PostgreSQL data is stored separately in `postgres-data`.

On a fresh database, open:

```text
http://localhost:8080/
```

The first-run UI creates the single owner account. Public signup is not enabled.

Reference deployment endpoints:

```text
http://localhost:8080/
http://localhost:8080/api/health/live
http://localhost:8080/api/health/ready
```

### Session cookie and HTTPS

For local plain HTTP, keep:

```text
SESSION_COOKIE_SECURE=false
```

When the instance is exposed through HTTPS, set `SESSION_COOKIE_SECURE=true`. Browsers do not send Secure cookies over plain HTTP, so do not enable this flag on an HTTP-only local deployment.

### Stop or reset

Stop the stack while preserving data:

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml down
```

Use `down -v` only when you intentionally want to remove both PostgreSQL and managed artifact volumes.

## Quality gate

With the test database running:

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

The canonical Phase 1 Docker smoke gate is:

```bash
docker compose -f deploy/docker/compose.yml up -d --build
node scripts/smoke-http.mjs
docker compose -f deploy/docker/compose.yml down -v
```

The smoke test verifies first-run setup, session persistence, project creation, note creation and revision-safe update, stale-write rejection, logout, and post-logout authorization.
