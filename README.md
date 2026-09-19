# Universal Workbench

Universal Workbench is a local-first, self-hosted-first workspace for connecting tools without losing project context or provenance.

The current implementation boundary is **Phase 2 — Local-First & Sync**. The browser now writes project and note state locally first, persists pending operations across reloads, synchronizes through authenticated device-bound HTTP/WebSocket transports, and preserves local edits through conflict resolution.

## Phase 2 capabilities

- first-run single-owner setup, login, session validation, logout, and owner-only authorization;
- project and revisioned-note data core from Phase 1;
- browser-local persistence with SQLite WASM + OPFS when available;
- durable IndexedDB fallback when OPFS/SQLite is unavailable;
- local-first project/note mutation with durable pending-operation journal;
- client-generated device identity with server registration and revocation;
- monotonic sync cursors and idempotent operation replay;
- HTTP catch-up as the durable recovery path;
- authenticated WebSocket HELLO/READY, ACK, replay, and remote-operation transport;
- stale-write conflict preservation with explicit keep-local or use-server resolution;
- durable tombstones preventing stale offline resurrection;
- sync status and non-secret diagnostics;
- canonical Docker Compose deployment with PostgreSQL, migrations, Express, nginx/PWA, OPFS isolation headers, and WebSocket proxying;
- permanent CI gates covering Chromium multi-device/offline/fallback/conflict/chaos behavior and Docker vertical smoke.

## Stack

- Node.js 24 LTS
- npm workspaces
- TypeScript
- React + Vite PWA
- SQLite WASM + OPFS / IndexedDB fallback
- Express API + WebSocket transport
- PostgreSQL + Drizzle
- Vitest + Playwright
- Docker Compose

## Repository layout

```text
apps/web            local-first PWA client and browser persistence
apps/server         Express API and sync WebSocket transport
packages/auth       owner authentication and sessions
packages/contracts  shared runtime contracts
packages/core       Action Layer and project domain
packages/documents  revisioned note domain
packages/artifacts  immutable artifact domain
packages/storage    artifact storage abstraction
packages/database   PostgreSQL repositories and migrations
packages/sync       durable sync service and conflict policy
packages/shared     deterministic shared primitives
deploy/docker       canonical self-host deployment
docs                architecture, runbooks, specs, and plans
```

## Next boundary

**Phase 3 owns Tool & Workflow execution**: typed tool contracts, execution records, linear-first DAG-capable workflows, permissions, and the first reusable `Send to...` paths.

AI providers, MCP/plugin expansion, broader upload ingestion, and later private-release hardening remain deferred to their roadmap phases.

See `docs/runbooks/local-development.md` for startup and verification commands, `docs/architecture/phase-2.md` for the current architecture, and `docs/superpowers/specs/2026-09-15-universal-workbench-design.md` for the approved product blueprint.
