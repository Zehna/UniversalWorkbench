# Phase 0 Architecture

Phase 0 establishes the build, runtime, database, PWA, deployment, and quality boundaries for Universal Workbench without implementing product-domain behavior.

## Implemented boundaries

- npm workspace modular monolith with `apps/web`, `apps/server`, and focused shared packages.
- React + Vite + TypeScript installable PWA shell with explicit manifest icons.
- Express + TypeScript server with runtime-validated configuration.
- Shared Zod contracts for error and health payloads.
- PostgreSQL as the only Phase 0 production server database.
- Drizzle ORM dependency and configuration boundary; domain tables intentionally begin in Phase 1.
- Injectable clock and ID primitives for deterministic later testing.
- Liveness and database-backed readiness endpoints.
- Request IDs are assigned before body parsing; malformed bodies and unknown routes return structured JSON error envelopes.
- PostgreSQL pools use bounded connection acquisition and an idle-client error listener.
- Reference Docker Compose deployment using PostgreSQL 17 with configurable database credentials.
- Filesystem/object-storage domain behavior is not implemented in Phase 0.
- CI definitions for static quality, runtime dependency audit, real PostgreSQL integration, PWA artifact verification, and Docker smoke verification.

## Runtime modes

Phase 0 accepts `APP_MODE=all|api`. Both modes run the HTTP API because no background-job runtime exists yet. `worker` remains a planned runtime role in the Master Blueprint, but Phase 0 rejects it rather than starting a no-op process that exits immediately. Worker mode will be enabled only when durable queue/job execution is implemented.

## Deliberately deferred

The following are outside the Phase 0 acceptance boundary:

- authentication and owner setup;
- Projects, Documents, Artifacts, and domain database tables;
- browser SQLite WASM and OPFS;
- WebSocket/local-first sync;
- durable operation journal and conflict handling;
- workflow engine and background job execution;
- AI providers and BYO-AI integration;
- Redis;
- server-side SQLite;
- plugin or MCP runtime;
- secrets vault;
- file/artifact storage implementation.

Adding any of these before Phase 0 is verified requires a plan revision rather than an opportunistic implementation.
