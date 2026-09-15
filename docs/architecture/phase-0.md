# Phase 0 Architecture

Phase 0 establishes the build, runtime, database, PWA, deployment, and quality boundaries for Universal Workbench without implementing product-domain behavior.

## Implemented boundaries

- npm workspace modular monolith with `apps/web`, `apps/server`, and focused shared packages.
- React + Vite + TypeScript PWA shell.
- Express + TypeScript server with runtime-validated configuration.
- Shared Zod contracts for error and health payloads.
- PostgreSQL as the only Phase 0 production server database.
- Drizzle ORM dependency and configuration boundary; domain tables intentionally begin in Phase 1.
- Injectable clock and ID primitives for deterministic later testing.
- Liveness and database-backed readiness endpoints.
- Request-ID middleware and bounded JSON request bodies.
- Reference Docker Compose deployment using PostgreSQL 17.
- Filesystem/object-storage domain behavior is not implemented in Phase 0.
- CI definitions for static quality, real PostgreSQL integration, and Docker smoke verification.

## Runtime modes

The server validates `APP_MODE=all|api|worker`. Phase 0 provides HTTP API behavior for `all` and `api`. `worker` is accepted as a forward-compatible runtime role but has no registered jobs in this phase.

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
