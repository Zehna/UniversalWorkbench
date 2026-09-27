# Phase 3 Architecture — Tool & Workflow Core

> Implementation reference for the `phase-3-tools-workflow` branch. The
> release boundary is not closed until Task 11 golden workflows, the expanded
> Docker smoke, the full security review, and same-commit CI are verified.

## Scope and package boundaries

Phase 3 adds typed, pinned tools and durable workflow execution to the Phase 2
local-first project workspace. The server remains a modular monolith, with
PostgreSQL 17 as its durable server database and queue.

| Package         | Responsibility                                                                           |
| --------------- | ---------------------------------------------------------------------------------------- |
| `@uw/contracts` | Versioned Zod schemas for context, tools, workflows and execution status.                |
| `@uw/context`   | Permission-aware compatibility matching for `Send to...` candidates.                     |
| `@uw/tools`     | Exact-version registry, input/output validation, local transforms and policy-gated HTTP. |
| `@uw/workflow`  | DAG, binding and permission preflight; immutable workflow-definition versions.           |
| `@uw/execution` | Execution engine, budgets, retries, cancellation, receipts and worker.                   |
| `@uw/database`  | PostgreSQL workflow definitions, execution records, steps, provenance and leased queue.  |
| `apps/server`   | Authenticated APIs, service composition and `all`/`api`/`worker` modes.                  |
| `apps/web`      | Mobile-first linear workflow editor, preflight, run status and artifact handoff.         |

Phase 2 local storage, sync, and conflict-resolution logic remains separate from
workflow execution. The browser uses SQLite WASM + OPFS where available and a
durable IndexedDB fallback otherwise.

## Tool and context contracts

`ContextEnvelope` carries a type (`text`, `markdown`, `json`,
`api_response`, or `artifact_ref`), schema version, MIME type, payload,
metadata, capabilities and provenance. The Context Bus lists compatible tools
based on declared input types and permissions; it cannot grant permissions.

Each `ToolDescriptor` includes an exact semantic version, accepted and
produced context types, permissions, capabilities, execution mode,
idempotency class and configuration schema. Workflows pin a specific
`toolId@version`. The registry resolves exact versions instead of silently
substituting newer implementations.

Current built-ins are `builtin.http.request@1.0.0`,
`builtin.json.extract@1.0.0`, `builtin.text.trim@1.0.0` and
`builtin.markdown.to-text@1.0.0`. The first is server-side and requires the
`network` permission. The remaining tools are deterministic transformations.

## Workflow preflight and persistence

Workflow definitions contain versioned nodes and dependency edges. Preflight
rejects cycles, self-dependencies, missing source nodes, invalid output indexes,
incompatible output/input types, unavailable pinned tool versions, unauthorized
permissions and unsafe automatic retry configurations. Execution-time checks
validate root input contexts, which are not statically typed in the workflow
definition.

Saving a changed workflow stores a new immutable definition version. Importing
or saving a workflow does not execute it. The run API validates the definition
and permissions before creating an execution and queue entry.

The initial UI edits a linear sequence with ordered steps and compatible
tool selection; the underlying validation and execution support DAGs. Arbitrary
cycles, user-supplied shell commands and arbitrary code execution are not
supported.

## Durable execution and worker

The engine records executions, individual attempts, typed input/output
contexts, provenance edges and a final execution receipt. PostgreSQL also
stores pending queue work with leases and reclaim after expiry. The worker
acknowledges work only after processing; completed steps are reused if leased
work is reclaimed. An uncertain in-flight unsafe operation is not blindly
replayed.

`APP_MODE=all` runs API, sync WebSocket and execution worker;
`APP_MODE=api` omits the worker; `APP_MODE=worker` runs the worker without an
HTTP listener. The queue requires PostgreSQL; there is no Redis dependency.

Execution budgets constrain step attempts, total duration and output bytes.
Cancellation propagates an `AbortSignal`. Safe tools may retry according to
their pinned step policy, while unsafe operations require an idempotency key
for retries. GET/HEAD HTTP requests are classified as safe per invocation;
mutating HTTP requests require a workflow-owned idempotency key.

Receipts contain execution and workflow IDs/versions, timings, step statuses,
tool versions, usage, output context IDs and provenance. They deliberately omit
input/output payloads, request headers, raw secrets and idempotency keys.

## Network and authorization boundaries

Protected API routes derive owner identity from the authenticated server
session, not from request JSON. Preflight checks server-granted permissions;
content supplied by a tool or source cannot extend those permissions. The
production composition currently grants no workflow network permission by
default. The deterministic HTTP fixture and its network grant are enabled only
with the explicit test environment guards in `apps/server/src/composition.ts`
(`WORKBENCH_E2E_FIXTURE` for browser E2E, `WORKBENCH_DOCKER_SMOKE_FIXTURE`
for the Docker smoke). Both are default-off and must never be enabled in
production.

The built-in HTTP tool permits only HTTP/HTTPS destinations passing its egress
policy. It validates DNS-resolved addresses, blocks local/private/link-local
targets, pins the validated address for transport, revalidates every redirect
hop, drops authorization on redirects and limits response size and duration.
Production code must never use the E2E fixture as an egress bypass.

`POST /api/projects/:projectId/artifacts/from-execution` accepts only a
completed, owner-scoped execution and a stored output-context ID. Artifact
content is taken from the server's execution record rather than user-supplied
payload bytes. The route currently serializes the output payload as JSON and
enforces a 512 KiB maximum.

## Verification and deferred scope

The Phase 0–2 sync, browser, Docker smoke and credential-canary gates remain
permanent. Phase 3 adds workflow contract, tool, engine, queue, API, browser and
golden-workflow coverage. The deployment smoke (`scripts/smoke-http.mjs`
with `WORKBENCH_DOCKER_SMOKE_FIXTURE=1`) covers the tool catalog, an
`HTTP -> JSON extract` execution with receipt and provenance checks, artifact
handoff via `from-execution`, and the cancellation gate, against a stack
running both `APP_MODE=all` and a worker-only service. The Phase 3 closing
gate additionally requires a fresh-PostgreSQL test run plus inspection for
secret leakage. A green CI run on an intermediate implementation is not proof
that every Task 11 requirement is complete.

AI providers and `HTTP -> JSON -> AI -> Note` are deferred to Phase 4. Wider
ingestion, MCP/plugin expansion and private-release hardening belong to later
phases.

See [the local development runbook](../runbooks/local-development.md) and
[the Phase 3 implementation plan](../superpowers/plans/2026-09-25-phase-3-tools-workflow-core.md).
