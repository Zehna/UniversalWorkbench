# Universal Workbench

Universal Workbench is a local-first, self-hosted-first workspace for connecting tools without losing project context or provenance.

**Phase 4 — AI Provider is under final verification on the development branch.** Phase 0–3 are merged to `main`; the branch adds a BYO-key AI provider seam, server vault encryption, the AI tool with structured outputs, execution token accounting, and Universal Send-to, while retaining Phase 2 local-first persistence, HTTP/WebSocket synchronization and explicit conflict resolution. Phase 4 is not release-complete until the remaining Task 11 checks pass on one final commit.

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

## Phase 3 capabilities (merged)

- typed context envelopes, permission-aware Context Bus and version-pinned Tool Registry;
- built-in HTTP, JSON extraction, text trim and Markdown-to-text tools;
- linear-first workflow editor backed by DAG validation and permission preflight;
- versioned workflow definitions, PostgreSQL execution records and a leased worker queue;
- bounded execution with structured errors, retry controls, cancellation, receipts and provenance;
- protected workflow APIs, status UI and server-scoped output saving as an Artifact;
- permanent Phase 3 Chromium workflow gate alongside Phase 2 browser-sync and Docker gates.

## Phase 4 development-branch capabilities

- BYO-key AI provider seam (`@uw/providers`): deterministic mock behind an
  explicit flag matrix, plus an OpenAI-compatible HTTP provider behind shared
  egress policy;
- server vault with AES-256-GCM envelope encryption and versioned keyring;
  `secret://vault/*` resolves at run time, `secret://local/*` stays on-device
  and fails closed on the server;
- `builtin.ai.complete@1.0.0` with text/JSON response formats, schema
  validation, and `ai_response` outputs carrying token usage;
- execution token accounting with `BUDGET_EXCEEDED` budgets and redacted,
  idempotent step persistence;
- Universal Send-to: every artifact, execution output, and note offers
  destinations generated from Context Bus compatibility plus granted
  permissions, including Save as Note and Save as Artifact;
- supported north-star flow: `HTTP -> JSON extract -> AI -> Note`, with
  per-step and total token usage, receipts, and provenance.

Production workflow network and `ai` permissions are not granted by default.
Deterministic HTTP fixtures and the mock AI provider used in browser tests are
test-only.

Task 11 is still in progress: golden AI workflow integration, expanded Phase 4
deployment smoke, security review and same-commit final verification. See
[the Phase 4 architecture](docs/architecture/phase-4.md) and
[the implementation plan](docs/superpowers/plans/2026-09-28-phase-4-ai-provider.md).

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
packages/context    typed context compatibility bus
packages/tools      version-pinned tool registry and built-ins
packages/workflow   DAG validation, preflight and workflow service
packages/execution  execution engine, receipts, retries and worker
packages/contracts  shared runtime contracts
packages/core       Action Layer and project domain
packages/documents  revisioned note domain
packages/artifacts  immutable artifact domain
packages/storage    artifact storage abstraction
packages/database   PostgreSQL repositories and migrations
packages/egress     standalone network policy
packages/providers  AI provider port, mock and HTTP providers
packages/sync       durable sync service and conflict policy
packages/shared     deterministic shared primitives
deploy/docker       canonical self-host deployment
docs                architecture, runbooks, specs, and plans
```

## Next boundary

**Finish Phase 4 Task 11 before merging.** MCP/plugin expansion, broader
ingestion and private-release hardening remain deferred.

See [the runbook](docs/runbooks/local-development.md), [Phase 2 architecture](docs/architecture/phase-2.md), [Phase 3 architecture](docs/architecture/phase-3.md), [Phase 4 architecture](docs/architecture/phase-4.md) and [the product blueprint](docs/superpowers/specs/2026-09-15-universal-workbench-design.md).
