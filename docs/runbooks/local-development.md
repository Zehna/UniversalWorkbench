# Local Development Runbook

Universal Workbench Phase 0 supports two development paths.

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

Start the API:

```bash
DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test APP_MODE=all npm run dev -w @uw/server
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

`APP_MODE=worker` is intentionally rejected in Phase 0 because the worker/queue runtime has not been implemented yet.

## Path 2: Canonical Docker Compose deployment

For a local reference deployment, create an environment file first:

```bash
cp deploy/docker/.env.example deploy/docker/.env
```

Change the development password in `deploy/docker/.env`, keeping `DATABASE_URL` consistent with the PostgreSQL values. If a password contains URI-reserved characters, URL-encode the password component only in `DATABASE_URL`.

Start and verify the stack:

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml up -d --build
node scripts/smoke-http.mjs
```

The smoke script uses bounded retries so a fresh container startup is not treated as a deployment failure while Nginx and the API become ready.

Reference deployment endpoints:

```text
http://localhost:8080/
http://localhost:8080/api/health/live
http://localhost:8080/api/health/ready
```

Stop the stack with:

```bash
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yml down
```

Use `down -v` only when you intentionally want to remove the reference PostgreSQL volume.

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

The canonical Docker smoke gate is:

```bash
docker compose -f deploy/docker/compose.yml up -d --build
node scripts/smoke-http.mjs
docker compose -f deploy/docker/compose.yml down -v
```
