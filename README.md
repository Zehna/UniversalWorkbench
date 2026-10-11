# Universal Workbench

Universal Workbench is a local-first, self-hosted-first workspace for connecting tools without losing project context or provenance.

**Phase 7 — HITL Guardrail & Streaming Agent is complete on `phase-7-hitl-streaming-agent`.** Phase 0–5 are merged to `main`; Phase 6 adds a goal-driven ReAct agent loop (`builtin.ai.agent@1.0.0`) with whitelisted tool calling, iteration (default 5, cap 15) and token budgets, prompt-injection isolation, secret-scrubbed trace persistence, Send-to Document/Artifact for agent outputs, and a trace timeline UI. Phase 7 adds human-in-the-loop approval for gated tools (`requiresApproval`, `awaiting_approval` suspend/resume with rejection feedback), real-time SSE trace streaming (`GET /executions/:id/events` + live `AgentTraceViewer`/`ApprovalCard`), and multi-tool parallel dispatch (`dispatchMany` via `Promise.allSettled`). See [the Phase 7 architecture](docs/architecture/phase-7.md) and [the Phase 6 architecture](docs/architecture/phase-6.md). Phase 5 remains ready for private release ([Phase 5 architecture](docs/architecture/phase-5.md), [private-deployment runbook](docs/runbooks/private-deployment.md)).

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

## Phase 5 capabilities (private release)

- artifact upload content verification: magic-byte sniffing, filename
  sanitization, strict size limits and SHA-256 checksums;
- destructive-action safeguards: confirmation-gated project and vault-secret
  deletion, ownership audit (`project.delete`, `vault.secret.delete`,
  `vault.rekey`), cross-owner IDOR concealment as 404;
- unified backup engine: PostgreSQL dump, artifact files, and encrypted vault
  envelope in one checksummed `.tar.gz` with `manifest.json`;
- automated restore drill: seed → backup → tamper negative → restore →
  assert, verified against PostgreSQL (`scripts/test-restore-drill.mjs`);
- system diagnostics: liveness/readiness probes plus an owner-authenticated,
  strictly redacted recovery bundle;
- resilient accessible web UI: virtualized lists, keyboard-navigable tabs,
  focus-trapped confirmation dialogs, offline banner with reconnect-aware
  execution polling, and truncated large-payload rendering;
- production hardening: resource-bounded rootless Compose deployment on an
  isolated network with fail-fast secrets, and a complete private self-hosting
  runbook (reverse proxy HTTPS, backup cron, disaster recovery, updates).

## Phase 6 capabilities (react agent)

- ReAct loop engine (`prompt -> thought + toolCall -> observation -> final`):
  `builtin.ai.agent@1.0.0` with default 5 iterations, hard cap 15, and early
  termination (`completed` vs `iteration_limit_reached`);
- provider tool-calling seam: `tools` on provider requests, `toolCalls` on
  results (mock + OpenAI-compatible HTTP), surfaced as function-calling specs;
- whitelist authorization: the agent can only invoke `allowedTools`-listed
  tools; disallowed calls become `UNAUTHORIZED_TOOL` error observations and
  content can never widen the server permission grant;
- prompt-injection mitigation: observations are serialized JSON context, the
  agent is excluded from its own dispatch set, and untrusted content cannot
  escalate tools or permissions;
- trace persistence with secret scrubbing: every thought, tool-call argument,
  duration, and observation is stored in `agent_response` (`text`, `status`,
  `iterations`, `trace`, `usage`); resolved `secret://` values persist only
  as `[REDACTED]`;
- token accounting: per-iteration usage accumulates into execution usage
  (provider vs estimated source), with the same budget guards as Phase 4;
- Universal Send-to for `agent_response` (Save as Note with `Agent result`
  title, Save as Artifact) plus the `AgentTraceViewer` timeline and
  `AgentStepEditor` (allowed tools, 1–15 iterations) in the web UI;
- golden coverage: `packages/execution/test/golden-agent.integration.test.ts`
  (HTTP tool → observe JSON → reason → final response, whitelist negative,
  iteration-cap termination, trace/token/Send-to/no-leak assertions).

## Phase 7 capabilities (hitl streaming agent)

- HITL guardrail: `requiresApproval` tool descriptors, agent suspend with
  `status: "awaiting_approval"` + `structured.pendingApprovals`, engine
  `suspend → awaiting_approval → resume → process` state machine with
  `resolveApproval({ decision, rejectionReason? })` validation;
- approval UX + API: `POST /executions/:id/approve` (empty body),
  `POST /executions/:id/reject` (`{ reason? }`, 1–2000 chars), owner-scoped
  404 concealment, 409 when not awaiting approval; `ApprovalCard`
  (approve/reject + reason, busy/error states);
- rejection feedback: denied calls become `"Action was rejected by user:
  <reason>"` error observations fed back into the agent conversation, so the
  agent completes alternatively without ever invoking the gated executor;
- real-time SSE streaming: `GET /executions/:id/events`
  (`text/event-stream`, history replay + 50 ms status poll up to 2 s,
  clean end on terminal/disconnect) and live `AgentTraceViewer` timeline
  (`EventSource` lifecycle, `approval_needed` embeds `ApprovalCard`);
- parallel dispatch: `AgentToolDispatcher.dispatchMany` fans out each
  iteration's tool calls via `Promise.allSettled` (per-call approval lookup
  by `toolCallId` then tool name; one failure becomes a per-call
  `TOOL_EXECUTION_FAILED` observation, never a batch failure);
- secret safety carried forward: resolved `secret://` plaintext scrubbed to
  `[REDACTED]` across text/traces/observations/errors plus redacted step
  persistence; golden HITL canary scan;
- golden coverage: `packages/execution/test/golden-hitl.integration.test.ts`
  (approve → tool runs → completed; reject with reason → completes without
  running gated tool, rejection visible, no secret leak).

## Test commands

```sh
npm test                                   # all workspace suites (includes Phase 7 golden HITL)
npm run typecheck                          # zero TypeScript errors required
npm run test -w @uw/execution              # execution engine + golden HITL/agent/AI suites
npm run test -w @uw/tools                  # agent executor + dispatcher HITL suites
npm run test -w @uw/server                 # HITL approve/reject + SSE streaming suites
npm run test -w @uw/web                    # ApprovalCard + AgentTraceViewer SSE suites
npm run typecheck --workspace=@uw/web      # web typecheck (requiresApproval on mocks)
npm run test -w @uw/providers              # provider tool-calling suite
npm run test -w @uw/contracts              # agent + HITL schema suites
```

No test sends real network traffic (deterministic injected transports) or
weakens the production egress policy. DB-backed suites need
`TEST_DATABASE_URL`.

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

**Phase 7 Task 6 gate is the merge boundary.** MCP/plugin expansion, broader
ingestion, multi-agent orchestration, and arbitrary code execution remain
deferred.

See [the runbook](docs/runbooks/local-development.md), [Phase 2 architecture](docs/architecture/phase-2.md), [Phase 3 architecture](docs/architecture/phase-3.md), [Phase 4 architecture](docs/architecture/phase-4.md), [Phase 5 architecture](docs/architecture/phase-5.md), [Phase 6 architecture](docs/architecture/phase-6.md), [Phase 7 architecture](docs/architecture/phase-7.md) and [the product blueprint](docs/superpowers/specs/2026-09-15-universal-workbench-design.md).
