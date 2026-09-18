# Universal Workbench

Universal Workbench is a local-first, self-hosted-first workspace for connecting tools without losing project context or provenance.

The current implementation boundary is **Phase 1 — Project and Data Core**. Phase 1 adds a private single-owner workbench with authenticated projects, revision-safe notes, immutable artifacts, a mobile-first PWA flow, explicit PostgreSQL migrations, and a Docker deployment smoke.

## Phase 1 capabilities

- first-run owner setup, login, session validation, logout, and owner-only authorization;
- project creation, listing, reading, and updates;
- note creation and revision-safe editing with stale-write conflict detection;
- immutable artifact metadata and bytes behind a storage abstraction;
- PostgreSQL persistence with Drizzle migrations applied explicitly before app startup;
- action auditing for project, document, and artifact mutations without storing content payloads;
- React + Vite PWA UX for owner setup/login, project selection, and note editing;
- Docker Compose reference deployment with PostgreSQL, one-shot migration, app, web, and persistent artifact storage;
- CI gates for formatting, linting, type checking, tests, production build, PWA verification, PostgreSQL integration, and Docker smoke.

## Stack

- Node.js 24 LTS
- npm workspaces
- TypeScript
- React + Vite PWA
- Express API
- PostgreSQL + Drizzle
- Vitest
- Docker Compose

## Repository layout

```text
apps/web            PWA client
apps/server         Express application
packages/auth       owner authentication and sessions
packages/contracts  shared runtime contracts
packages/core       Action Layer and project domain
packages/documents  revisioned note domain
packages/artifacts  immutable artifact domain
packages/storage    artifact storage abstraction
packages/database   PostgreSQL repositories and migrations
packages/shared     deterministic shared primitives
deploy/docker       canonical self-host deployment
docs                architecture, runbooks, specs, and plans
```

## Next boundary

**Phase 2 owns local-first state and synchronization**: browser SQLite WASM + OPFS, durable operation journal, device identity, WebSocket synchronization, cursors/ACKs, tombstones, and conflict synchronization.

Workflow/tool execution, AI providers, MCP, arbitrary uploads, and broader private-release hardening remain intentionally deferred to later phases.

See `docs/runbooks/local-development.md` for startup and verification commands, `docs/architecture/phase-1.md` for the current architecture, and `docs/superpowers/specs/2026-09-15-universal-workbench-design.md` for the approved product blueprint.
