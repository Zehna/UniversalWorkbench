# Phase 3 Design — Tool & Workflow Core

**Status:** PROPOSED  
**Date:** 2026-09-19  
**Branch:** `phase-3-tool-workflow-core`  
**Parent:** `main@d5d5979dc6a05e4b5f8419073d7a529dab699a79`  
**Blueprint:** `docs/superpowers/specs/2026-09-15-universal-workbench-design.md`

## 1. Goal

Phase 3 turns Universal Workbench from a local-first project workspace into a safe, typed execution platform.

The smallest trusted proof for this phase is:

```text
Project
  -> public HTTP request
  -> immutable API-response context
  -> JSON parse/select
  -> text rendering
  -> Note write
  -> durable execution receipt
  -> provenance
  -> same workflow can be rerun deterministically enough to explain what happened
```

Phase 3 does **not** attempt the Phase 4 north-star AI step. Its purpose is to make the execution substrate trustworthy before AI, secrets, plugins, or MCP can depend on it.

## 2. Product boundary

Phase 3 implements:

- versioned Context Envelopes;
- Context Bus compatibility;
- Tool Contract and Tool Registry;
- durable tool/workflow Execution records;
- PostgreSQL-backed execution queue;
- worker runtime and `APP_MODE=worker`;
- retries, timeout, cancellation, idempotency, and budgets;
- immutable execution receipts;
- provenance edges;
- DAG workflow model and validation;
- mobile-first linear workflow editor;
- workflow definitions as revisioned project documents;
- public HTTP Tool with deny-by-default safe egress;
- deterministic JSON and Text tools;
- Note write tool backed by the existing Action Layer/document service;
- initial contextual target discovery built on Context Bus compatibility;
- golden workflows and browser/deployment verification.

Phase 3 intentionally defers:

- AI providers and AI Tool;
- BYO API keys and Cloud Vault secret resolution;
- MCP/plugin runtime;
- arbitrary JavaScript/shell/code execution;
- unrestricted LAN/private-network HTTP;
- general graph editor;
- workflow cycles and arbitrary loops;
- scheduled/cron workflows;
- multi-user permission UI;
- distributed Redis queue;
- large-file processing pipelines;
- remote browser automation;
- marketplace/installable extensions.

## 3. Design decisions

### 3.1 Server-authoritative execution

Workflow definitions are local-first project data, but workflow **execution requires an online server** in Phase 3.

Every actual tool/workflow run executes through the server-side durable queue, including deterministic JSON/Text tools. This gives one execution model, one receipt format, one permission boundary, one retry policy, and one provenance model.

Local execution remains an architectural Tool Contract mode but is not implemented as a runtime path in Phase 3.

### 3.2 PostgreSQL queue first

The queue is PostgreSQL-backed and part of the modular monolith.

No Redis dependency is introduced.

Workers claim jobs with row locking and leases. `APP_MODE=all` runs API + sync + worker in one process. `APP_MODE=api` does not execute queued work. `APP_MODE=worker` runs the worker loop without opening the HTTP listener.

### 3.3 HTTP Tool choice: safe public egress

Phase 3 uses real public HTTP with safe egress from day one.

The safe baseline is:

- `http:` and `https:` only;
- public destinations only;
- loopback/private/link-local/metadata/internal/reserved targets denied;
- URL userinfo denied;
- credential-like query parameters denied in v1;
- redirects revalidated hop by hop;
- DNS results validated before connection;
- validated address is pinned for that connection to prevent DNS rebinding;
- implicit proxy environment variables are not honored by the safe transport;
- no ambient cookies;
- no ambient authorization credentials;
- credential-bearing headers are denied;
- response bytes, redirects, and wall-clock time are bounded.

LAN access may become an explicit owner capability later. It is unavailable in Phase 3.

## 4. Package boundaries

Phase 3 creates the package boundaries already reserved by the blueprint:

```text
packages/context/
  envelope.ts
  compatibility.ts
  registry.ts

packages/tools/
  contract.ts
  registry.ts
  errors.ts
  permissions.ts
  builtin/http/
  builtin/json/
  builtin/text/
  builtin/note/

packages/execution/
  model.ts
  repository.ts
  queue.ts
  engine.ts
  receipt.ts
  budget.ts
  retry.ts

packages/workflow/
  model.ts
  validate.ts
  planner.ts
  bindings.ts
  service.ts
```

`@uw/database` implements PostgreSQL repositories/queue adapters.

`@uw/server` owns HTTP routes, composition, and worker lifecycle.

`@uw/web` owns the linear workflow editor and execution-history UI.

Domain packages must not import Drizzle or Express.

## 5. Context Envelope

Every tool input/output crossing a tool boundary uses a runtime-validated envelope.

Conceptual contract:

```ts
interface ContextEnvelope<TPayload = unknown> {
  id: string;
  type: ContextType;
  schemaVersion: number;
  mimeType: string;
  metadata: Record<string, JsonValue>;
  payload: TPayload;
  provenance: {
    projectId: string;
    artifactIds: string[];
    executionId?: string;
    stepExecutionId?: string;
    parentContextIds: string[];
  };
  capabilities: ContextCapability[];
}
```

Phase 3 core types:

```text
text
markdown
json
api-response
artifact-ref
note-ref
error
```

Rules:

- envelope IDs are UUIDs;
- schema version starts at 1 per type;
- metadata is JSON-safe and non-secret;
- payloads are runtime validated;
- normal inline JSON/text payloads are capped at 1 MiB serialized;
- large HTTP bodies are stored as immutable Artifacts and referenced from `api-response`;
- no raw password/session/cookie/authorization value may appear in metadata, provenance, or receipts.

### 5.1 API response context

HTTP does not dump arbitrary multi-megabyte bodies into workflow JSON.

Its output envelope contains:

```ts
{
  status: number;
  headers: Record<string, string>;
  url: string;              // final sanitized URL
  bodyArtifactId: string;
  bodyMimeType: string;
  bodySizeBytes: number;
}
```

Safe response headers are persisted. Credential/set-cookie headers are omitted.

### 5.2 Context compatibility

Compatibility is type-driven, not screen-driven.

A tool declares accepted input types and produced output types. The Context Bus can answer:

```text
Given this envelope, which registered tool inputs are compatible?
```

Phase 3 compatibility is exact-type plus explicitly registered adapters. There is no fuzzy AI-based compatibility.

Examples:

- `api-response -> json.parse`
- `json -> json.select`
- `json -> text.template`
- `text -> note.write`
- `markdown -> note.write`

## 6. Tool Contract

Each tool is immutable by ID + version.

Conceptual contract:

```ts
interface ToolDefinition {
  id: string;
  version: string;
  displayName: string;
  description: string;
  executionMode: "local" | "server" | "worker" | "hybrid";
  accepts: ToolInputPort[];
  produces: ToolOutputPort[];
  configSchema: JsonSchemaLike;
  requiredCapabilities: ToolCapability[];
  defaults: {
    timeoutMs: number;
    maxAttempts: number;
  };
}
```

Phase 3 runtime also requires:

```ts
interface ToolRunner {
  run(context: ToolRunContext): Promise<ToolRunResult>;
}
```

Definitions are data. Runners are trusted server code.

Workflow definitions pin both `toolId` and exact `toolVersion`. A future tool upgrade never silently changes an existing workflow revision.

## 7. Tool Registry

The Tool Registry is deterministic and process-local.

It:

- registers trusted built-in Tool Definitions and runners;
- rejects duplicate ID/version pairs;
- exposes compatibility queries;
- resolves an exact pinned version;
- exposes capability requirements;
- never dynamically imports arbitrary repository/user code in Phase 3.

No plugin installation exists yet.

## 8. Capabilities and permissions

Phase 3 capability vocabulary starts intentionally small:

```text
network.public
project.documents.read
project.documents.write
project.artifacts.read
project.artifacts.write
```

The Tool Contract declares capabilities.

The execution preflight computes the union for the requested tool/workflow and rejects unavailable capabilities before enqueueing.

Built-in owner-only Phase 3 policy allows:

- `network.public`;
- project document/artifact read/write for projects owned by the authenticated owner.

Unavailable:

- `network.lan`;
- raw secret access;
- shell/filesystem host access;
- arbitrary DB access.

Tools cannot grant themselves permissions from input content.

## 9. Built-in tools

### 9.1 `builtin.http.request@1`

Execution mode: `worker`

Input: configuration + optional text/json body binding.

Output: `api-response`.

Supported methods:

- GET
- HEAD
- POST
- PUT
- PATCH
- DELETE

Limits:

- max redirects: 5;
- default timeout: 15 s;
- hard timeout: 30 s;
- max response body: 5 MiB;
- bounded response headers;
- no automatic cookie jar;
- no authorization/cookie/proxy-authorization headers;
- URL userinfo rejected;
- public network only.

### 9.2 `builtin.json.parse@1`

Execution mode: `worker`

Accepts:

- `text`;
- `api-response` whose body is loaded from its Artifact.

Produces: `json`.

No JSON5/eval behavior.

### 9.3 `builtin.json.select@1`

Execution mode: `worker`

Accepts: `json`.

Configuration uses JSON Pointer, not arbitrary JavaScript or JQ.

Produces: `json`.

### 9.4 `builtin.text.template@1`

Execution mode: `worker`

Accepts: `json`, `text`, or `markdown`.

Uses a deliberately small placeholder syntax. No expression evaluation, filesystem access, JavaScript, or network access.

Produces: `text` or `markdown`.

### 9.5 `builtin.note.write@1`

Execution mode: `worker`

Accepts: `text` or `markdown`.

Writes a note through the existing document service + Action Layer.

Produces: `note-ref`.

The runner never writes directly through a database repository.

## 10. Safe HTTP egress

Safe HTTP transport is a reusable boundary below the HTTP Tool.

### 10.1 Destination validation

Before every request hop:

1. parse URL;
2. require HTTP/HTTPS;
3. reject username/password URL userinfo;
4. reject unsupported ports if policy disallows them;
5. reject credential-like query keys in Phase 3;
6. resolve DNS A/AAAA records;
7. reject the destination if **any** returned address is non-public;
8. choose a validated address;
9. pin the connection to that validated address while preserving the original host for Host/SNI;
10. on redirect, repeat from step 1.

Blocked classes include at minimum:

- IPv4/IPv6 loopback;
- RFC1918/private;
- link-local;
- unspecified;
- multicast;
- carrier-grade NAT;
- IPv4-mapped blocked IPv6;
- cloud/link-local metadata ranges;
- internal names that resolve to blocked addresses.

The implementation should prefer a well-tested IP classification library or Node primitives plus exhaustive regression tests rather than hand-wavy string-prefix checks.

### 10.2 Request credential policy

Phase 3 public HTTP is intentionally unauthenticated.

Forbidden request headers include at minimum:

- Authorization
- Cookie
- Proxy-Authorization

Header names commonly used specifically for API credentials are also denied until Phase 4 secret references exist.

URLs with embedded credentials or credential-like query parameters are rejected rather than persisted and redacted later.

### 10.3 Response sanitization

Do not persist:

- Set-Cookie;
- Proxy-Authenticate;
- other credential-bearing response values.

Redirect URLs are stored only after sanitization and successful policy validation.

## 11. Execution model

Execution kinds:

```text
tool
workflow
```

Execution statuses:

```text
queued
running
succeeded
failed
cancelled
timed_out
```

Terminal states are immutable.

Conceptual durable execution:

```ts
interface Execution {
  id: string;
  ownerId: string;
  projectId: string;
  kind: "tool" | "workflow";
  workflowRevisionId?: string;
  status: ExecutionStatus;
  traceId: string;
  idempotencyKey: string;
  budget: ExecutionBudget;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancellationRequestedAt?: string;
  error?: SanitizedExecutionError;
}
```

## 12. Step execution

Every tool invocation within a workflow has its own durable step record.

States:

```text
pending
queued
running
succeeded
failed
skipped
cancelled
timed_out
```

A step records:

- node ID;
- pinned tool ID/version;
- attempt number;
- input context IDs/artifact references;
- output context IDs/artifact references;
- started/finished timestamps;
- sanitized error;
- resource usage.

## 13. PostgreSQL queue

Phase 3 implements a queue adapter with PostgreSQL.

A queue job contains:

- job ID;
- execution ID;
- optional step execution ID;
- queue type;
- attempt;
- available-at;
- lease owner;
- lease expiry;
- created-at.

Claiming uses a transaction with row-level locking and `SKIP LOCKED`.

Worker rules:

- only one active lease owns a job;
- expired leases may be reclaimed;
- successful completion deletes/archives the queue job transactionally with execution state;
- retry schedules a new `available_at`;
- cancellation prevents new work from being claimed;
- all handlers are idempotency-aware.

## 14. Runtime modes

Phase 3 makes the blueprint runtime modes real:

### `APP_MODE=all`

- HTTP API
- sync WebSocket
- queue worker

### `APP_MODE=api`

- HTTP API
- sync WebSocket
- no worker loop

### `APP_MODE=worker`

- queue worker only
- no HTTP listener
- no WebSocket listener

Graceful shutdown stops new claims, aborts active cancellable operations, returns/finishes leases safely, then closes PostgreSQL.

The Docker reference deployment remains `APP_MODE=all` in Phase 3. Separate worker deployment is verified but optional.

## 15. Idempotency

Execution creation accepts a client-generated idempotency key.

For the same owner + project + execution-kind + idempotency key:

- duplicate enqueue returns the original Execution;
- it does not create another run.

Tool side effects also receive a deterministic step idempotency scope.

`note.write` must not create duplicate notes if a worker lease is retried after an ambiguous failure.

HTTP requests themselves cannot be assumed safe to replay merely because the queue is idempotent. Retry policy therefore considers method + failure class.

Default automatic retry is allowed for:

- GET;
- HEAD;
- explicitly idempotent tool runners.

POST/PATCH/DELETE are not automatically retried after an ambiguous upstream write unless the tool can prove replay safety.

## 16. Retry taxonomy

Tool failures are normalized into structured codes.

Core categories:

```text
VALIDATION
PERMISSION_DENIED
UNSAFE_EGRESS
NETWORK_TRANSIENT
UPSTREAM_RATE_LIMIT
UPSTREAM_4XX
UPSTREAM_5XX
TIMEOUT
CANCELLED
OUTPUT_TOO_LARGE
BUDGET_EXCEEDED
TOOL_BUG
```

Retryable by default:

- transient connect/reset errors;
- HTTP 408;
- HTTP 429 with bounded Retry-After;
- HTTP 5xx for retry-safe methods/tools.

Never retry by default:

- validation;
- permission;
- unsafe egress;
- ordinary 4xx;
- output-too-large;
- cancellation;
- budget exceeded;
- tool bug.

Retry uses bounded exponential backoff with jitter and a phase-wide hard maximum of 3 attempts.

## 17. Budgets

Every execution has explicit limits.

Phase 3 budget fields:

```ts
interface ExecutionBudget {
  maxWallClockMs: number;
  maxSteps: number;
  maxAttemptsPerStep: number;
  maxTotalAttempts: number;
  maxOutputBytes: number;
  maxHttpRequests: number;
}
```

Defaults are conservative.

Workflow preflight rejects a definition whose static minimum exceeds the budget.

Runtime checks stop execution with `BUDGET_EXCEEDED` before starting more work.

AI token/cost budget fields are deferred to Phase 4.

## 18. Cancellation and timeout

Cancellation is cooperative but durable.

API cancellation sets `cancellation_requested_at`.

Workers check cancellation:

- before a step;
- before retry;
- during long-running cancellable tools.

HTTP uses `AbortController`.

A cancelled execution never transitions back to running.

Timeout and cancellation are distinct terminal receipts.

## 19. Immutable execution receipts

Each terminal step and execution produces an immutable receipt.

Receipt fields include:

- execution/step IDs;
- workflow revision ID if applicable;
- pinned tool ID/version;
- sanitized configuration fingerprint;
- input context/artifact IDs;
- output context/artifact IDs;
- capability set;
- attempt count;
- timestamps/duration;
- result status;
- structured sanitized error;
- usage counters;
- provenance edges.

Receipts never contain raw passwords, cookies, authorization headers, secret values, or full credential-bearing URLs.

## 20. Provenance

Phase 3 persists provenance edges for outputs.

Conceptual edge:

```text
input Artifact/Context
  --[execution step + tool version]-->
output Artifact/Context
```

The minimum durable edge records:

- project ID;
- execution ID;
- step execution ID;
- source artifact/context ID;
- target artifact/context ID;
- relation;
- created-at.

Provenance is append-only.

## 21. Workflow definition

Workflow definitions are project Documents.

Phase 3 extends the document kind model:

```text
note
workflow
```

Workflow content is versioned JSON:

```ts
interface WorkflowDefinitionV1 {
  schemaVersion: 1;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  outputs: WorkflowOutputBinding[];
}
```

Node:

```ts
interface WorkflowNode {
  id: string;
  tool: {
    id: string;
    version: string;
  };
  config: JsonValue;
}
```

Edge:

```ts
interface WorkflowEdge {
  from: { nodeId: string; output: string };
  to: { nodeId: string; input: string };
}
```

No executable code is stored in workflow definitions.

## 22. Workflow validation

Before save and again before execution:

- node IDs unique;
- every tool version exists;
- configs validate;
- referenced ports exist;
- context types are compatible;
- required inputs are bound;
- no cycles;
- no self-loop;
- at least one terminal output or side-effect node;
- capability union allowed;
- static budget limits acceptable.

Cycle detection uses a deterministic graph algorithm.

Imported workflow documents never auto-execute.

## 23. Workflow planning

The execution planner:

1. validates the pinned workflow revision;
2. creates durable step records;
3. computes dependency counts;
4. marks root nodes runnable;
5. queues runnable steps;
6. when a step succeeds, binds outputs to downstream inputs;
7. queues newly unblocked nodes;
8. fails/skips downstream nodes according to workflow failure policy;
9. completes the workflow when all reachable nodes are terminal.

Phase 3 has one failure policy:

`fail-fast`

Branch-specific recovery policies are deferred.

## 24. Workflow concurrency

DAG-capable execution may run independent ready nodes concurrently, bounded by:

- execution budget;
- queue worker concurrency;
- tool-specific concurrency policy.

The initial Docker profile keeps conservative worker concurrency.

## 25. Workflow documents and local-first sync

Workflow definitions participate in the existing local-first document model.

Phase 3 generalizes the document revision contracts/local stores from note-only content to a discriminated union that can persist workflow content.

Important rules:

- editing a workflow is local-first;
- each workflow edit creates a local document revision and sync operation;
- server canonical revision is compare-and-swap protected;
- workflow-definition conflicts preserve both versions and require explicit resolution;
- **running a workflow requires the canonical synced revision**;
- an unsynced/conflicted workflow cannot be executed.

This prevents executing a revision the server cannot durably identify.

## 26. Linear-first workflow UI

The Phase 3 editor is deliberately list-first.

Mobile flow:

```text
Workflows
  -> New Workflow
  -> Add Step
  -> choose compatible tool
  -> configure
  -> bind input from previous/available output
  -> validate
  -> save locally
  -> sync
  -> Run
  -> execution timeline/receipt
```

The UI can author a linear chain.

The underlying model remains DAG-capable, and imported/API-created valid DAGs can execute. A graph editor is not built in Phase 3.

No drag-only interaction is required; move-up/move-down controls are first-class.

## 27. Initial Context Bus UX

Phase 3 does not ship the full universal Phase 4 `Send to...` experience.

It does ship the primitive required for it:

```text
selected context
  -> Context Bus compatibility query
  -> list compatible built-in targets
```

The workflow editor uses this same query when choosing the next step.

One contextual path may be exposed as proof:

`text/markdown -> Note`

Phase 4 will turn the same capability into the universal polished `Send to...` surface and add AI targets.

## 28. Server API

Minimum protected Phase 3 routes:

```text
GET    /tools
POST   /tools/compatibility

GET    /projects/:projectId/workflows
POST   /projects/:projectId/workflows
GET    /projects/:projectId/workflows/:workflowId
PATCH  /projects/:projectId/workflows/:workflowId
POST   /projects/:projectId/workflows/:workflowId/validate

POST   /projects/:projectId/executions
GET    /projects/:projectId/executions
GET    /projects/:projectId/executions/:executionId
POST   /projects/:projectId/executions/:executionId/cancel
GET    /projects/:projectId/executions/:executionId/receipt
```

All mutation routes use runtime schemas and server-authoritative ownership checks.

No route accepts client-supplied owner IDs.

## 29. Database additions

Phase 3 adds durable tables conceptually equivalent to:

```text
executions
execution_steps
execution_outputs
execution_receipts
execution_queue
provenance_edges
```

Workflow definitions themselves remain in Documents/Revisions.

### 29.1 Execution rows

Execution mutable state is limited to lifecycle fields.

### 29.2 Receipts and provenance

Receipts/provenance are append-only.

### 29.3 Queue

Queue rows are operational durability, not user-facing history.

Migrations are explicit and forward-only under the existing Drizzle migration discipline.

## 30. Artifact policy

Immutable tool outputs are persisted through the existing Artifact service.

HTTP response body bytes are Artifacts.

Text/JSON outputs that participate in provenance also receive immutable output Artifacts or equivalent persisted execution-output snapshots so a receipt can always reference exactly what downstream steps consumed.

Artifact creation remains behind the storage abstraction.

## 31. Logging and redaction

Structured execution logs may include:

- execution ID;
- step ID;
- tool ID/version;
- status;
- duration;
- safe error code;
- byte counts;
- retry attempt.

They must not include:

- raw HTTP request body by default;
- raw HTTP response body;
- Cookie;
- Set-Cookie;
- Authorization;
- proxy credentials;
- owner password;
- session token;
- future secret values.

HTTP URL logging uses the validated/sanitized URL policy.

## 32. Golden workflows

Permanent Phase 3 golden workflows:

### A. HTTP -> JSON -> Text -> Note

Proves:

- egress;
- Artifact body;
- JSON parse/select;
- typed binding;
- text rendering;
- Action Layer note write;
- provenance;
- receipt.

### B. JSON -> select -> Text -> Note

Runs without network dependency after initial input.

### C. failing HTTP -> retry -> structured failure

Uses a deterministic local test server in the test environment, not an unsafe production egress bypass.

Proves:

- retry classification;
- attempts;
- terminal sanitized error;
- receipt.

### D. cancellation

Long-running deterministic test tool/fixture is cancelled.

Proves:

- durable cancellation request;
- worker observation;
- terminal receipt.

## 33. Testing strategy

### Contract tests

- Context Envelope schemas;
- Tool definitions;
- workflow definition;
- execution/error/receipt schemas.

### Unit tests

- compatibility;
- DAG cycle detection;
- binding validation;
- retry classifier;
- budgets;
- safe URL/IP policy;
- redaction.

### PostgreSQL integration tests

- execution lifecycle;
- queue claim/lease/reclaim;
- idempotent enqueue;
- receipts;
- provenance;
- workflow document revision/conflict support.

### Security tests

- loopback/private/link-local/metadata targets blocked;
- IPv6 variants blocked;
- DNS rebinding/pinned-address behavior;
- redirect to blocked destination blocked;
- credential-bearing headers/URL rejected;
- logs/receipts contain no secret canaries.

### Browser E2E

- create linear workflow;
- save locally;
- sync;
- run;
- inspect timeline;
- note output visible;
- second browser sees workflow and execution result.

### Deployment smoke

Docker profile runs:

`HTTP fixture -> JSON -> Text -> Note`

through the real queue worker in `APP_MODE=all`.

A separate process-level test verifies `APP_MODE=worker` does not listen on the HTTP port and still drains queued work.

## 34. Acceptance criteria

Phase 3 is complete only when:

1. Tool Contract and Context Bus are runtime validated.
2. Workflow definitions pin exact tool versions.
3. Workflow definitions reject cycles and type-incompatible bindings.
4. Workflow edits remain local-first and sync safely.
5. Unsynced/conflicted workflow revisions cannot run.
6. Executions are durable and idempotently enqueued.
7. PostgreSQL queue survives worker restart/lease expiry tests.
8. Retry/cancel/timeout/budget transitions are verified.
9. Receipts and provenance are immutable and secret-free.
10. Public HTTP works for safe destinations.
11. Unsafe network destinations and redirects are blocked.
12. HTTP response bodies are immutable Artifacts.
13. JSON/Text/Note built-ins work through the same execution engine.
14. `APP_MODE=all|api|worker` behavior is verified.
15. Golden workflows pass.
16. Browser linear editor/E2E passes.
17. Docker Phase 3 vertical smoke passes.
18. full existing Phase 0–2 regression suite remains green.
19. production dependency audit remains green.
20. post-merge `main` CI is green.

## 35. Intentional future hooks

The design leaves explicit hooks for Phase 4/5 without implementing them:

- `secret://...` config values;
- AI Tool runner;
- MCP/plugin Tool Registry adapters;
- S3 output storage;
- Redis queue adapter;
- owner-configurable LAN egress capability;
- richer workflow failure policies;
- scheduled runs;
- graph editor;
- backup/export of execution receipts.

These hooks must not add alternate implementations during Phase 3.

## 36. Alternatives considered

### HTTP hardening deferred to Phase 5

Rejected.

Reason: the HTTP Tool creates a server-side network primitive. Shipping it first and securing it later would violate an existing permanent security invariant and create SSRF debt at the execution foundation.

### Mock-only HTTP in Phase 3

Rejected.

Reason: the phase must prove the real execution pipeline and the golden HTTP workflow. Deterministic local fixtures remain appropriate for tests, but the product Tool is real public HTTP.

### Redis immediately

Rejected.

Reason: PostgreSQL already exists, is canonical, and is sufficient for the initial private/self-hosted worker profile. The queue interface preserves replacement later.

### Workflow table separate from Documents

Rejected.

Reason: the blueprint explicitly makes workflow definitions revisioned Documents. Reusing revision/sync/conflict semantics keeps one mutable-content model.

### Graph editor now

Rejected.

Reason: DAG execution capability is required; a graph authoring surface is not. Linear-first UI keeps the mobile product usable and the Phase 3 scope bounded.

### Arbitrary JavaScript transform tool

Rejected.

Reason: it violates the no-arbitrary-code v0.1 boundary and dramatically enlarges sandbox/security scope. JSON Pointer and constrained text templating cover the initial workflow proof safely.

## 37. Phase 3 completion boundary

When Phase 3 closes, Universal Workbench should be able to explain:

- what workflow revision ran;
- which exact tool versions ran;
- what inputs each step consumed;
- what outputs each step produced;
- which capabilities were required;
- how many attempts occurred;
- why a retry happened;
- whether a budget or cancellation stopped the run;
- which immutable artifacts and provenance edges resulted;
- whether the run was reproduced from an unchanged pinned workflow.

That trusted execution substrate is the required foundation for Phase 4 AI and universal `Send to...`.
