# Universal Workbench Phase 0 Foundation Implementation Plan

> Status: implemented on `phase-0-foundation`; this in-repo copy includes the corrections accepted during PR review.

## Goal

Establish a clean modular-monolith foundation that boots a React/Vite PWA and Express API against PostgreSQL, exposes liveness/readiness checks, runs through the canonical Docker Compose deployment, and passes reproducible CI quality gates.

## Scope

Phase 0 contains infrastructure and platform boundaries only. Product-domain behavior such as authentication, Projects, Documents, Artifacts, local-first sync, workflows, AI providers, plugins/MCP, file storage, and a background-job runtime is intentionally deferred.

## Locked stack

- Node.js 24.21.0
- npm workspaces
- TypeScript
- React 19.3
- Vite 8.x
- Express 5.x
- PostgreSQL 17
- Drizzle ORM 0.45.2+
- Zod runtime validation
- Vitest + Supertest + React Testing Library
- ESLint + Prettier
- Docker Compose

## Repository boundaries

```text
apps/
  web/       React/Vite PWA
  server/    Express API
packages/
  contracts/ runtime schemas and shared payload contracts
  database/  PostgreSQL/Drizzle boundary
  shared/    deterministic Clock and ID primitives
deploy/
  docker/    canonical reference deployment
scripts/     workspace, PWA, and deployment verification
docs/        architecture and operational runbooks
```

## Task 1 — Workspace foundation

Create npm workspaces for `@uw/web`, `@uw/server`, `@uw/contracts`, `@uw/database`, and `@uw/shared`.

Acceptance:

- Node engine constrained to the Node 24 line.
- `.nvmrc` pins 24.21.0.
- workspace verifier confirms every required package manifest.
- root scripts provide format, lint, typecheck, test, and build entry points.

## Task 2 — Runtime contracts

Create Zod contracts for health and structured error payloads.

Acceptance:

- schemas parse valid fixtures;
- invalid fixtures are rejected;
- generated TypeScript types are exported through `@uw/contracts`.

## Task 3 — Deterministic shared primitives

Create injectable Clock and UUID/ID primitives rather than scattering direct time/random calls through future domain code.

Acceptance:

- production implementations exist;
- deterministic test implementations/fixtures verify the contracts.

## Task 4 — PostgreSQL foundation

Create the PostgreSQL connection and readiness boundary using `pg` and Drizzle ORM.

Acceptance:

- PostgreSQL is the only server production database in Phase 0;
- integration tests run against a real PostgreSQL 17 service;
- connection acquisition is bounded with a timeout;
- the Pool has an idle-client error listener;
- production dependency audit reports no high/critical runtime advisory.

## Task 5 — Express foundation

Create validated configuration, request IDs, bounded JSON parsing, liveness, and database-backed readiness endpoints.

Phase 0 runtime modes are `all|api`. `worker` is deliberately rejected until a durable job runtime exists.

Acceptance:

- `/health/live` does not depend on PostgreSQL;
- `/health/ready` reports database readiness and returns 503 when unavailable;
- request IDs are assigned before body parsing;
- malformed JSON returns a request-correlated 400 JSON error envelope;
- oversized request bodies preserve client-error semantics;
- unknown routes return a request-correlated JSON 404 envelope;
- unsupported/unfinished runtime modes are rejected during config validation.

## Task 6 — PWA shell

Create the React/Vite application shell and service-worker-enabled PWA.

Acceptance:

- production frontend build succeeds;
- manifest contains standalone launch metadata;
- explicit 192x192 and 512x512 icon assets are shipped;
- `scripts/verify-pwa.mjs` verifies the built manifest and referenced icon files.

## Task 7 — Canonical Docker deployment

Create Dockerfiles for server and web plus a Compose stack with PostgreSQL.

Acceptance:

- PostgreSQL has a healthcheck;
- app starts only after PostgreSQL is healthy;
- web starts only after the app is healthy;
- database credentials can be overridden using an env file;
- a separate `DATABASE_URL` override supports URI-safe configuration;
- HTTP smoke verification uses bounded retries to tolerate normal fresh-container startup time;
- smoke verifies web root, API liveness, and API readiness.

## Task 8 — CI and documentation

Create permanent CI and operating docs.

The quality job must execute, in order:

```text
npm ci
npm audit --omit=dev --audit-level=high
workspace verification
Prettier check
ESLint
TypeScript typecheck
full tests with PostgreSQL 17
production build
PWA artifact verification
```

The Docker job must:

```text
build and start Docker Compose
run HTTP smoke verification
print deployment logs
tear down containers and volumes
```

Documentation must describe:

- actual Phase 0 runtime modes;
- local Node/PostgreSQL development;
- canonical Docker Compose startup;
- env-file handling;
- health endpoints;
- quality-gate commands;
- deliberately deferred capabilities.

## PR review corrections incorporated

The final Phase 0 implementation additionally incorporates review-driven regressions for:

1. rejecting the no-op worker mode;
2. bounding PostgreSQL connection acquisition;
3. observing idle PostgreSQL Pool errors;
4. assigning request IDs before JSON parsing;
5. preserving 400/413 request error semantics;
6. returning structured JSON 404 responses;
7. adding PWA icons plus post-build verification;
8. making Docker smoke startup tolerant with bounded retries;
9. making Compose credentials genuinely configurable;
10. removing a stale contracts tsconfig include.

Behavior fixes were introduced with regression tests first and verified red before implementation.

## Phase 0 exit gate

Phase 0 can be closed only when the final PR head has fresh evidence for all of the following:

```text
DEPENDENCY INSTALL     PASS
RUNTIME SECURITY AUDIT PASS
WORKSPACE CHECK        PASS
FORMAT                 PASS
LINT                   PASS
TYPECHECK              PASS
TESTS + POSTGRES       PASS
PRODUCTION BUILD       PASS
PWA VERIFY             PASS
DOCKER BUILD/START     PASS
HTTP SMOKE             PASS
TEARDOWN               PASS
```

No Phase 1 domain implementation is included in this plan.
