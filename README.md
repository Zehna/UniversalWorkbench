# Universal Workbench

Universal Workbench is a local-first, self-hosted-first workspace for connecting tools without losing project context, execution history, or provenance.

The current implementation boundary is **Phase 3 — Tool & Workflow Core**.

The browser remains local-first for projects, notes, and workflow definitions. Canonical synced workflow revisions can now run through a durable server-side execution engine with a PostgreSQL queue, version-pinned built-in tools, retries/cancellation/budgets, receipts, provenance, and a linear-first workflow UI.

## Phase 3 capabilities

- all Phase 0–2 foundation, project/data, local-first, and multi-device sync behavior;
- typed Context Envelopes and deterministic context compatibility;
- versioned Tool Contract and exact `toolId@version` registry resolution;
- revisioned local-first workflow Documents;
- DAG validation/planning with a mobile-friendly linear authoring UI;
- canonical-revision execution preflight;
- durable executions and step records;
- PostgreSQL queue with leases, reclaim, and worker-safe idempotency;
- `APP_MODE=all|api|worker`;
- bounded retry, timeout, cancellation, and execution budgets;
- immutable execution outputs, receipts, and provenance;
- safe public HTTP with deny-by-default DNS/IP/redirect policy;
- built-in HTTP, JSON Parse, JSON Select, Text Template, and Note Write tools;
- execution timeline with step attempts and output references;
- initial Context Bus compatibility UX that forms the foundation for `Send to...`;
- permanent browser workflow, worker-mode, safe-egress, Docker workflow, and Phase 2 regression gates.

## Security boundary

Phase 3 public HTTP does not provide raw secret configuration and does not permit localhost/private-network bypass.

URLs, DNS answers, redirects, headers, body size, timeout, and response headers are validated or bounded. Credential-bearing request/response data is rejected or removed before durable persistence.

AI providers, BYO API keys, secret vault resolution, MCP/plugins, arbitrary code execution, LAN egress, workflow loops, scheduling, Redis, and a graph editor remain outside the Phase 3 boundary.

## Stack

- Node.js 24 LTS
- npm workspaces
- TypeScript
- React + Vite PWA
- SQLite WASM + OPFS / IndexedDB fallback
- Express + WebSocket
- PostgreSQL + Drizzle
- Vitest + Playwright
- Docker Compose

## Repository layout

```text
apps/web            local-first PWA, workflow editor, execution timeline
apps/server         API, sync WebSocket, composition, execution runtime
packages/auth       owner authentication and sessions
packages/contracts  shared runtime schemas
packages/core       Action Layer and project domain
packages/context    Context Envelope and compatibility primitives
packages/tools      Tool Contract, registry, permissions, built-in tools
packages/workflow   DAG validation, planning, canonical workflow service
packages/execution  execution state, worker, queue ports, retry/budget/receipts
packages/documents  revisioned note/workflow domain
packages/artifacts  immutable artifact domain
packages/storage    artifact storage abstraction
packages/database   PostgreSQL repositories, execution queue, migrations
packages/sync       durable local-first sync service
packages/shared     deterministic shared primitives
deploy/docker       canonical self-host deployment
docs                architecture, runbooks, specs, and implementation plans
```

## Next boundary

**Phase 4 owns AI & universal Send to...** on top of the Phase 3 execution substrate.

Phase 4 may introduce provider adapters and secret references, but it should reuse the existing Tool Registry, Context Bus, execution queue, capabilities, receipts, and provenance rather than creating an AI-only execution path.

See:

- `docs/architecture/phase-3.md` for the current architecture;
- `docs/runbooks/local-development.md` for runtime and verification commands;
- `docs/superpowers/specs/2026-09-19-phase-3-tool-workflow-core-design.md` for the approved Phase 3 design;
- `docs/superpowers/specs/2026-09-15-universal-workbench-design.md` for the product blueprint.
