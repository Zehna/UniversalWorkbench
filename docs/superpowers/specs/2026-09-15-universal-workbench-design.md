# Universal Workbench — Master Blueprint v1

**Status:** APPROVED on 2026-09-15  
**Direction:** private/self-hosted-first, cloud-capable, local-first, mobile-first  
**Primary clients:** PWA on phones, tablets, and desktop browsers  
**Canonical deployment:** Docker Compose + PostgreSQL

## 1. Product vision

Universal Workbench is a project-centric workspace that connects AI, APIs, data, research, notes, files, and workflows without losing context or provenance. Its value is not the number of tools; its value is that tools share typed context and can be chained safely.

North-star v0.1 flow:

```text
Create Project
  -> HTTP Request
  -> JSON output
  -> Send to AI
  -> AI result
  -> Send to Note
  -> saved locally
  -> synced
  -> opened on another device
```

## 2. Permanent product principles

1. Local-first.
2. Self-hosted-first.
3. Cloud-capable.
4. Project-centric.
5. Privacy-first.
6. Mobile-first.
7. Typed context.
8. Composable tools.
9. Reproducible workflows.
10. Portable data.

## 3. v0.1 non-goals

v0.1 does not implement a cloud IDE, shell execution, arbitrary code execution, GPU/model hosting, video generation, hundreds of utilities, a full Postman/Zotero clone, realtime multiplayer editing, enterprise teams, billing, a plugin marketplace, arbitrary workflow loops, Kubernetes, microservices, Redis as a requirement, server-side SQLite production support, or zero-downtime deployment.

Extension points may exist without alternate implementations.

## 4. High-level architecture

```text
React/Vite PWA
  |
SQLite WASM + OPFS local state
  |
Action + Sync client
  |
WebSocket + HTTP recovery
  |
Express TypeScript application
  |-- API mode
  |-- Worker mode
  |-- Combined mode
  |
PostgreSQL
  |
Filesystem storage (default) / S3-compatible adapter
```

## 5. Repository structure

```text
apps/
  web/
  server/
packages/
  contracts/
  core/
  database/
  documents/
  artifacts/
  context/
  tools/
  workflow/
  execution/
  auth/
  storage/
  sync/
  providers/
  shared/
deploy/
  docker/
docs/
```

The repository is a modular monolith. Boundaries are explicit even when deployed as one process.

## 6. Runtime modes

The same server code supports:

- `APP_MODE=all` — API, WebSocket, and background work in one process.
- `APP_MODE=api` — request/sync serving only.
- `APP_MODE=worker` — background execution only.

v0.1 self-hosting defaults to `APP_MODE=all`.

## 7. Technology baseline

- Node.js 24 LTS.
- TypeScript.
- React + Vite PWA.
- Express 5.x.
- PostgreSQL server database.
- Drizzle ORM behind repository interfaces.
- SQLite WASM + OPFS for preferred local browser persistence.
- IndexedDB fallback for essential local persistence if OPFS cannot be used.
- npm workspaces for the monorepo.

## 8. Core data primitives

### Project

A Project is the ownership, permission, sync, storage, and export boundary.

### Document

A mutable object such as a note, prompt, workflow definition, API request definition, research record, or saved query. Every edit creates a `DocumentRevision`.

### Artifact

An immutable output such as an API response, AI result, upload, transformed file, extracted text, citation snapshot, or workflow output. Transforming an Artifact creates another Artifact.

### Execution

A durable record of a tool or workflow run. It records status, inputs, outputs, usage, timing, and trace identity.

### Operation

A durable mutation record used for offline sync, acknowledgements, conflict detection, reconnect, and diagnostics. The application is not fully event-sourced; canonical state remains in normal tables.

## 9. Typed context

All tool outputs use a versioned envelope conceptually containing:

```text
id
type
schemaVersion
mimeType
metadata
payload
provenance
capabilities
```

The payload is extensible and runtime-validated. Core example types include text, markdown, JSON, table, file, image, API response, AI response, citation, and citation metadata.

## 10. Context Bus and Send to...

The Context Bus determines which tools/actions accept a selected object. `Send to...` is generated from type compatibility, capability declarations, and permissions rather than hard-coded per screen.

## 11. Tool Contract

Each built-in tool, future plugin, MCP adapter, or integration declares:

- stable ID and version;
- accepted input types;
- produced output types;
- runtime config schema;
- required permissions/capabilities;
- execution mode: local, server, worker, or hybrid.

Workflow definitions pin tool versions.

## 12. Action Layer

All state-changing work from UI, AI, workflows, plugins, MCP, and HTTP APIs passes through the same validation/authorization/action boundary. AI and external content never gain a privileged bypass.

## 13. Workflow engine

Internally workflows are DAGs. The mobile-first v0.1 editor presents a linear step list. General cyclic graphs and arbitrary loops are forbidden in v0.1.

Execution includes:

- preflight schema/graph validation;
- required-secret and permission checks;
- typed bindings;
- durable state transitions;
- timeout/cancellation;
- explicit retry classification;
- idempotency keys;
- resource budgets;
- immutable execution receipts;
- provenance edges.

AI is a Tool, not a separate subsystem.

## 14. Local-first sync

The model is:

```text
local state + operation journal + server revision state
```

Local writes commit locally first, append a pending Operation, update the UI immediately, then sync.

WebSocket is the primary realtime transport but not the source of durability. The durable protocol uses operation IDs, revisions, cursors, and explicit ACKs. HTTP recovery endpoints remain available.

Conflict policy:

- safe metadata may be deterministically merged;
- tags may use set union;
- content conflicts preserve both versions;
- workflow-definition conflicts require explicit resolution;
- immutable Artifacts and Execution outputs do not merge.

No silent last-write-wins for important user content.

Deletion uses tombstones so offline clients cannot resurrect removed objects.

## 15. Selective sync and local storage

Projects and Artifacts may be locally pinned, local+cloud, or cloud-only. Large Artifact binaries sync metadata first and download on demand. Local cached/temporary content may be garbage-collected without deleting durable server data.

## 16. Secrets

Two secret scopes are supported architecturally:

- Local Secret — device-only, never synced.
- Cloud Vault — encrypted server-side and referenced by name.

Projects/workflows store references such as `secret://provider/name`, never the raw value.

Raw secret values must not appear in normal logs, exports, provenance, operation journals, analytics, or recovery bundles.

## 17. Authentication and authorization

v0.1 defaults to a built-in owner account created during first-run setup. Public signup is disabled. Sessions are server-side and use secure cookies.

The auth boundary is adapter-based so OIDC/passkeys can be added later.

Authentication does not imply authorization. Ownership/project membership is checked server-side for every protected resource. Client-supplied owner/user/role fields are never trusted.

## 18. Security model

Permanent invariants:

1. Secrets never appear in normal logs/export/history/provenance.
2. Every state-changing action is authorized server-side.
3. AI/plugins/MCP cannot bypass the Action Layer.
4. User-provided content is untrusted.
5. Outbound network access passes through SSRF/egress policy.
6. Imported projects/workflows never auto-execute.
7. Destructive actions are auditable.
8. Client-provided ownership data is untrusted.
9. Integrations use least privilege.
10. A compromised extension should not automatically compromise the workspace.

The HTTP tool blocks loopback, link-local, private network ranges, metadata endpoints, internal hosts, unsafe schemes, DNS rebinding targets, and redirects to blocked destinations by default. Self-host owners may explicitly enable LAN access.

Uploads pass size, filename, MIME/content-sniff, hash, staging, and safe-storage checks. Uploaded names never become direct filesystem paths.

## 19. Plugin/MCP future boundary

Extensions run through a sandbox/capability gateway and do not directly receive cookies, the primary DB, the Vault, or unrestricted DOM/filesystem access. MCP servers are external trust boundaries and receive only the minimum required context.

## 20. Deployment

Reference deployment is Docker Compose with PostgreSQL and persistent storage. One command should eventually bring up the reference stack, followed by first-run owner setup.

Deployment profiles:

- LOCAL — private machine/LAN, local filesystem, combined app mode.
- PRIVATE — HTTPS VPS/cloud, owner-only, backups, optional S3-compatible storage.
- SCALE — future API/worker replicas, managed PostgreSQL, S3, optional Redis adapter.

Self-hosted instances do not require a central license/account/telemetry service.

## 21. Storage and queue adapters

Interfaces exist for replacement, but v0.1 implements only the necessary path:

- server DB: PostgreSQL only;
- storage: local filesystem first, S3-compatible optional profile;
- queue: PostgreSQL-backed implementation first;
- auth: built-in implementation first.

Rule: design for replacement; do not implement every replacement.

## 22. Backup and recovery

Sync is not backup. Instance recovery requires PostgreSQL data, Artifact storage, instance configuration references, and the Vault master key backed up separately.

Backups must be verified by restore drills. Losing the Vault master key means encrypted Vault secrets cannot be recovered.

## 23. Product UX

Navigation is project-first and mobile-first. Mobile primary navigation is Home, Search, Run, and Me. Project views are Overview, Notes, Artifacts, Workflows, and History.

AI/API/JSON/citation functionality appears as contextual tools/actions rather than top-level navigation.

Mobile workflows use list-first step editing. Desktop may add a graph view later while preserving list view as first-class.

Offline state is explicit: Synced, Offline, Syncing, or Conflict. Successful local writes show `Saved locally` instead of generic network errors.

## 24. Accessibility and performance

Semantic HTML, keyboard access, visible focus, accessible labels/dialogs, reduced-motion support, scalable text, touch-friendly controls, and non-drag alternatives are required from the start.

Large JSON/data views must paginate/virtualize/lazy-load rather than freeze mobile browsers. Heavy graph tooling is not part of initial startup bundles.

## 25. Testing philosophy

Testing layers:

1. Contract tests.
2. Unit tests.
3. Integration tests.
4. Security regression tests.
5. Browser end-to-end tests.
6. Recovery/deployment tests.

Critical PostgreSQL integration tests use a real PostgreSQL instance. AI is mocked by deterministic providers in the normal suite. Real-provider checks are opt-in.

Permanent golden workflows include:

- HTTP -> JSON -> Note;
- HTTP -> JSON -> AI -> Note;
- JSON -> Transform -> Artifact;
- failing HTTP -> Retry -> structured Error.

The canonical E2E is the north-star flow through a second client/device.

## 26. Release gates

Stable releases require evidence for typecheck, lint, unit, contracts, PostgreSQL integration, workflow golden tests, sync tests, security tests, desktop/mobile E2E, Docker smoke, migrations, and backup/restore.

P0 data-loss/auth-bypass/secret-leak issues and P1 critical-flow failures block a stable release.

## 27. Roadmap

### Phase 0 — Foundation

Monorepo, React/Vite, Express, PostgreSQL/Drizzle baseline, contracts, Docker reference deployment, CI, health checks.

### Phase 1 — Project & Data Core

Owner auth, Projects, Documents/Revisions, Artifacts, storage abstraction, Action Layer, runtime schemas.

### Phase 2 — Local-First & Sync

SQLite WASM/OPFS, operation journal, WebSocket durable protocol, cursors/ACK, conflict preservation, tombstones, device identity/revocation.

### Phase 3 — Tool & Workflow Core

Tool Contract, Context Bus, execution engine, DAG model, linear UI, queue, retries, receipts, provenance, budgets, initial HTTP/JSON/text tools.

### Phase 4 — AI & Universal Send to...

AI provider abstraction, BYO secrets, AI Tool, Send to..., structured outputs, usage accounting; complete north-star flow.

### Phase 5 — Hardening & Private Release

SSRF/security hardening, upload pipeline, backup/restore, diagnostics, recovery bundles, upgrades, performance/accessibility verification, private deployment docs.

## 28. Final architectural rules

- Design extension points early, implement only the current path.
- Content may request actions; content cannot grant permissions.
- User data remains portable even if the application disappears.
- A feature is complete only when its behavior is verified with evidence.
- v0.1 is the smallest trustworthy proof of `API -> JSON -> AI -> Note -> Sync`, not the full long-term platform.
