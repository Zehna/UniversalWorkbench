# Phase 3 — Tool & Workflow Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the typed Tool Contract, Context Bus, durable workflow/execution core, PostgreSQL-backed queue, retries/budgets/provenance/receipts, initial HTTP/JSON/text/markdown tools, protected APIs, and a mobile-first linear workflow runner.

**Architecture:** Phase 3 extends the existing modular monolith with four new packages: `@uw/context`, `@uw/tools`, `@uw/workflow`, and `@uw/execution`. Tool definitions are pure capability declarations plus executors; workflows pin tool versions and use typed bindings; the execution service validates and authorizes before persisting durable execution state and queue work. PostgreSQL remains the durable server store and queue; `APP_MODE=worker` becomes valid only now that a real worker loop exists.

**Tech Stack:** Node.js 24 LTS, TypeScript 5.9, Zod 4, Express 5, PostgreSQL 17, Drizzle ORM, React 19/Vite 8 PWA, Vitest 5, Playwright Chromium, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-09-15-universal-workbench-design.md`

## Global Constraints

- Node.js remains `>=24 <25`; CI uses Node `24.21.0`.
- PostgreSQL is the only server database in v0.1.
- Queue implementation is PostgreSQL-backed; do not add Redis.
- Workflows are DAGs internally and linear-first in the v0.1 UI; arbitrary cycles/loops are forbidden.
- No arbitrary shell or user-supplied code execution.
- Workflow definitions pin exact tool versions.
- AI is not implemented in Phase 3; Phase 4 adds AI as another Tool.
- All state-changing HTTP/workflow actions remain behind the existing authentication/authorization and Action Layer boundaries.
- Imported or persisted workflow definitions never auto-run.
- Content may request actions; content cannot grant permissions.
- Raw secrets must not enter logs, operation journals, provenance, receipts, execution inputs, or error envelopes.
- Built-in HTTP execution accepts only HTTP/HTTPS and must pass an outbound egress policy before every request and redirect; LAN/private access stays disabled by default.
- Local-first/sync behavior from Phase 2 must remain intact.
- Existing Phase 0–2 permanent CI, Docker, browser-sync, and secret-leak gates must continue passing.

## Review Focus

1. **Workflow cycles or self-dependencies:** validation must reject the graph before an execution row or queue item is created; Task 5 owns this regression test.
2. **Type-incompatible bindings:** a node expecting `json` must not accept `text` unless the Tool Contract explicitly lists that type; Task 5 owns this regression test.
3. **Retrying unsafe tools:** tools classified `unsafe` must never be automatically retried after an ambiguous failure; Task 8 owns this regression test.
4. **HTTP redirect to a blocked/private target:** every redirect hop must be revalidated by the egress policy; Task 4 owns this regression test.
5. **Worker crash after claim:** a leased queue item must become claimable again after lease expiry while completed execution steps remain idempotent; Task 7 owns this integration test.

---

### Task 1: Phase 3 contracts and package boundaries

**Files:**
- Create: `packages/contracts/src/context.ts`
- Create: `packages/contracts/src/tool.ts`
- Create: `packages/contracts/src/workflow.ts`
- Create: `packages/contracts/src/execution.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/context/package.json`
- Create: `packages/context/tsconfig.json`
- Create: `packages/context/src/index.ts`
- Create: `packages/tools/package.json`
- Create: `packages/tools/tsconfig.json`
- Create: `packages/tools/src/index.ts`
- Create: `packages/workflow/package.json`
- Create: `packages/workflow/tsconfig.json`
- Create: `packages/workflow/src/index.ts`
- Create: `packages/execution/package.json`
- Create: `packages/execution/tsconfig.json`
- Create: `packages/execution/src/index.ts`
- Test: `packages/contracts/test/phase-3-contracts.test.ts`
- Modify: `scripts/verify-workspaces.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces:
```ts
type ContextType =
  | "text"
  | "markdown"
  | "json"
  | "api_response"
  | "artifact_ref";

interface ContextEnvelope<T = unknown> {
  id: string;
  type: ContextType;
  schemaVersion: 1;
  mimeType: string;
  metadata: Record<string, unknown>;
  payload: T;
  provenance: {
    executionId?: string;
    stepId?: string;
    sourceContextIds: string[];
  };
  capabilities: string[];
}

type ToolExecutionMode = "local" | "server" | "worker" | "hybrid";
type ToolIdempotency = "safe" | "keyed" | "unsafe";

interface ToolDescriptor {
  id: string;
  version: string;
  name: string;
  description: string;
  accepts: ContextType[];
  produces: ContextType[];
  permissions: string[];
  capabilities: string[];
  executionMode: ToolExecutionMode;
  idempotency: ToolIdempotency;
  configSchema: Record<string, unknown>;
}

interface WorkflowDefinition {
  id: string;
  projectId: string;
  name: string;
  schemaVersion: 1;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

type ExecutionStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
```

- [ ] **Step 1: Write RED contract tests** proving valid envelopes/tool descriptors/workflow definitions parse, malformed versions/types fail, duplicate node IDs fail schema-level uniqueness, and execution status is closed over the six declared values.
- [ ] **Step 2: Run RED test:** `npm test -w @uw/contracts -- phase-3-contracts.test.ts`. Expected failure: Phase 3 exports/schemas do not exist.
- [ ] **Step 3: Implement the four contract modules** with Zod schemas and inferred TypeScript types; do not add tool runtime behavior here.
- [ ] **Step 4: Add the four package manifests/tsconfigs/index exports** with the same build/typecheck/test script conventions as existing packages.
- [ ] **Step 5: Extend root build order and workspace verification** so the new packages are explicit permanent workspaces.
- [ ] **Step 6: Run GREEN:** contract test, `npm run verify:workspaces`, `npm run typecheck`, then full `npm test`.
- [ ] **Step 7: Commit:** `feat: add phase 3 tool workflow contracts`.

### Task 2: Context Bus and compatibility resolution

**Files:**
- Create: `packages/context/src/compatibility.ts`
- Create: `packages/context/src/bus.ts`
- Modify: `packages/context/src/index.ts`
- Test: `packages/context/test/context-bus.test.ts`

**Interfaces:**
- Consumes: `ContextEnvelope`, `ToolDescriptor`.
- Produces:
```ts
interface ContextCandidate {
  toolId: string;
  toolVersion: string;
  acceptedType: ContextType;
}

interface ContextBus {
  compatibleTools(
    context: ContextEnvelope,
    tools: readonly ToolDescriptor[],
    grantedPermissions: ReadonlySet<string>,
  ): ContextCandidate[];
}
```

- [ ] **Step 1: Write RED tests** for exact type match, multi-type acceptance, missing permission exclusion, deterministic ordering by tool ID/version, and zero candidates for unknown/incompatible types.
- [ ] **Step 2: Run RED:** `npm test -w @uw/context`. Expected failure: Context Bus implementation missing.
- [ ] **Step 3: Implement compatibility as pure functions**; no network, database, or React dependencies.
- [ ] **Step 4: Run GREEN** for context tests and full suite.
- [ ] **Step 5: Commit:** `feat: add typed context compatibility bus`.

### Task 3: Tool registry and deterministic local tools

**Files:**
- Create: `packages/tools/src/errors.ts`
- Create: `packages/tools/src/registry.ts`
- Create: `packages/tools/src/runtime.ts`
- Create: `packages/tools/src/builtin/json.ts`
- Create: `packages/tools/src/builtin/text.ts`
- Create: `packages/tools/src/builtin/markdown.ts`
- Modify: `packages/tools/src/index.ts`
- Test: `packages/tools/test/registry.test.ts`
- Test: `packages/tools/test/local-tools.test.ts`

**Interfaces:**
```ts
interface ToolRunContext {
  executionId: string;
  stepId: string;
  projectId: string;
  traceId: string;
  signal: AbortSignal;
  permissions: ReadonlySet<string>;
}

interface ToolRunResult {
  outputs: ContextEnvelope[];
  usage: { inputBytes: number; outputBytes: number };
}

interface ToolExecutor {
  descriptor: ToolDescriptor;
  run(
    input: ContextEnvelope,
    config: unknown,
    context: ToolRunContext,
  ): Promise<ToolRunResult>;
}

interface ToolRegistry {
  register(tool: ToolExecutor): void;
  resolve(id: string, version: string): ToolExecutor;
  list(): ToolDescriptor[];
}
```

Built-ins:
- `builtin.json.extract@1.0.0`: JSON input + dot-path config -> JSON output.
- `builtin.text.trim@1.0.0`: text input -> trimmed text output.
- `builtin.markdown.to-text@1.0.0`: markdown input -> plain text without executing/rendering HTML.

- [ ] **Step 1: Write RED registry tests** for duplicate `id@version`, exact version resolution, missing version typed error, and deterministic list order.
- [ ] **Step 2: Write RED built-in tests** for valid transforms, invalid config, incompatible input type, input immutability, deterministic output metadata/provenance.
- [ ] **Step 3: Run RED:** `npm test -w @uw/tools`.
- [ ] **Step 4: Implement registry/runtime validation and the three deterministic tools** using runtime schemas at every input/config boundary.
- [ ] **Step 5: Run GREEN** workspace tests and full suite.
- [ ] **Step 6: Commit:** `feat: add tool registry and local transforms`.

### Task 4: Safe built-in HTTP tool

**Files:**
- Create: `packages/tools/src/network/egress-policy.ts`
- Create: `packages/tools/src/network/http-tool.ts`
- Modify: `packages/tools/src/index.ts`
- Test: `packages/tools/test/egress-policy.test.ts`
- Test: `packages/tools/test/http-tool.test.ts`

**Interfaces:**
```ts
interface EgressPolicy {
  assertAllowed(url: URL): Promise<void>;
}

interface HttpToolConfig {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}
```

Descriptor:
- ID/version: `builtin.http.request@1.0.0`
- accepts: `json | text | markdown`
- produces: `api_response`
- permission: `network`
- execution mode: `server`
- idempotency: classify GET/HEAD as safe; mutating methods require an explicit workflow idempotency key and otherwise behave as unsafe.

- [ ] **Step 1: Write RED egress tests** rejecting non-HTTP(S), credentials-in-URL, localhost, loopback, private IPv4/IPv6, link-local, metadata-style link-local, and DNS resolutions containing blocked addresses.
- [ ] **Step 2: Write RED redirect test** where the first public URL redirects to a blocked private target; expect rejection before the second request.
- [ ] **Step 3: Write RED HTTP tests** for timeout, response-size cap, normalized lower-risk response metadata, no Set-Cookie forwarding, and structured network errors.
- [ ] **Step 4: Run RED:** `npm test -w @uw/tools -- egress-policy.test.ts http-tool.test.ts`.
- [ ] **Step 5: Implement the policy with injected DNS resolver/fetch adapter** so tests never depend on public internet. Validate every redirect manually with redirect mode disabled/controlled.
- [ ] **Step 6: Implement HTTP execution** with AbortController timeout, byte cap, response envelope containing status/selected headers/body, and no cookie jar.
- [ ] **Step 7: Run GREEN** tool tests and full suite.
- [ ] **Step 8: Commit:** `feat: add policy-gated http tool`.

### Task 5: Workflow DAG model, typed bindings, and preflight

**Files:**
- Create: `packages/workflow/src/errors.ts`
- Create: `packages/workflow/src/graph.ts`
- Create: `packages/workflow/src/bindings.ts`
- Create: `packages/workflow/src/preflight.ts`
- Modify: `packages/workflow/src/index.ts`
- Test: `packages/workflow/test/graph.test.ts`
- Test: `packages/workflow/test/preflight.test.ts`

**Interfaces:**
```ts
interface WorkflowNode {
  id: string;
  toolId: string;
  toolVersion: string;
  config: unknown;
  input: {
    source: "workflow_input" | "node_output";
    nodeId?: string;
    outputIndex?: number;
  };
  timeoutMs?: number;
  retry?: { maxAttempts: number; backoffMs: number };
  idempotencyKey?: string;
}

interface PreflightPlan {
  orderedNodeIds: string[];
  requiredPermissions: string[];
  requiresNetwork: boolean;
  warnings: string[];
}

function validateWorkflow(
  workflow: WorkflowDefinition,
  registry: ToolRegistry,
): ValidatedWorkflow;

function buildPreflightPlan(
  workflow: ValidatedWorkflow,
  grantedPermissions: ReadonlySet<string>,
): PreflightPlan;
```

- [ ] **Step 1: Write RED graph tests** for deterministic topological order, cycle/self-edge rejection, dangling edge rejection, duplicate IDs, and disconnected-but-valid DAG handling.
- [ ] **Step 2: Write RED binding tests** for incompatible context types, missing source node, invalid output index, and exact pinned tool-version lookup.
- [ ] **Step 3: Write RED preflight tests** proving missing permission prevents execution planning and network requirement is visible before run.
- [ ] **Step 4: Run RED:** `npm test -w @uw/workflow`.
- [ ] **Step 5: Implement graph/binding/preflight validation as pure code**; no persistence yet.
- [ ] **Step 6: Run GREEN** workflow tests and full suite.
- [ ] **Step 7: Commit:** `feat: add workflow dag validation and preflight`.

### Task 6: Durable execution, step, provenance, and receipt persistence

**Files:**
- Modify: `packages/database/src/schema.ts`
- Create: `packages/database/drizzle/0003_phase3_execution.sql`
- Create: `packages/execution/src/model.ts`
- Create: `packages/execution/src/repository.ts`
- Create: `packages/database/src/repositories/execution.ts`
- Modify: `packages/database/src/index.ts`
- Modify: `packages/execution/src/index.ts`
- Test: `packages/database/test/phase-3-migration.integration.test.ts`
- Test: `packages/database/test/execution.integration.test.ts`

**Tables:**
- `workflow_definitions`: immutable version rows with project ownership, name, schema version, definition JSON, created_at.
- `executions`: project/owner/workflow version/status/trace/input context/start/end/error/usage.
- `execution_steps`: execution ID, node ID, tool ID/version, attempt, status, timing, input/output context JSON, structured error, idempotency key.
- `provenance_edges`: execution ID, from-context ID, to-context ID, node ID.
- `execution_receipts`: one immutable final JSON receipt per execution.

**Interfaces:**
```ts
interface ExecutionRepository {
  createExecution(input: CreateExecutionRecord): Promise<ExecutionRecord>;
  markRunning(executionId: string, startedAt: Date): Promise<void>;
  recordStep(input: ExecutionStepRecord): Promise<void>;
  complete(input: CompleteExecutionRecord): Promise<void>;
  fail(input: FailExecutionRecord): Promise<void>;
  cancel(executionId: string, finishedAt: Date): Promise<void>;
  get(ownerId: string, projectId: string, executionId: string): Promise<ExecutionView | null>;
}
```

- [ ] **Step 1: Write RED migration tests** for constraints/status checks/FKs and one-receipt-per-execution uniqueness.
- [ ] **Step 2: Write RED repository tests** proving legal state persistence, immutable final receipt, cross-owner concealment, and structured error/usage round-trip.
- [ ] **Step 3: Run RED** against a fresh PostgreSQL test database.
- [ ] **Step 4: Implement migration/schema/repository**; raw secrets are not schema fields.
- [ ] **Step 5: Run GREEN twice from clean migration state** and full suite.
- [ ] **Step 6: Commit:** `feat: add durable workflow execution records`.

### Task 7: PostgreSQL queue, leasing, and worker runtime

**Files:**
- Create: `packages/execution/src/queue.ts`
- Create: `packages/database/src/repositories/execution-queue.ts`
- Modify: `packages/database/src/schema.ts`
- Create: `packages/database/drizzle/0004_phase3_queue.sql`
- Create: `packages/execution/src/worker.ts`
- Modify: `packages/execution/src/index.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/composition.ts`
- Test: `packages/database/test/execution-queue.integration.test.ts`
- Test: `packages/execution/test/worker.test.ts`
- Test: `apps/server/test/config.test.ts`

**Interfaces:**
```ts
interface ExecutionQueue {
  enqueue(executionId: string, availableAt: Date): Promise<void>;
  claim(workerId: string, now: Date, leaseMs: number): Promise<QueueLease | null>;
  ack(lease: QueueLease): Promise<void>;
  release(lease: QueueLease, availableAt: Date): Promise<void>;
}

interface ExecutionWorker {
  runOnce(): Promise<"processed" | "idle">;
}
```

- [ ] **Step 1: Write RED queue integration tests** for FIFO among available rows, `FOR UPDATE SKIP LOCKED` concurrency, lease ownership, ACK, delayed release, and lease-expiry reclaim.
- [ ] **Step 2: Write RED worker test** proving claimed execution is delegated once and ACKed only after the processor finishes.
- [ ] **Step 3: Add RED config tests** accepting `APP_MODE=worker` and requiring no HTTP listener in worker-only mode.
- [ ] **Step 4: Run RED.**
- [ ] **Step 5: Implement PostgreSQL queue and worker loop** with bounded idle polling and clean SIGTERM shutdown.
- [ ] **Step 6: Update server runtime modes:** `all` starts API+WS+worker, `api` starts API+WS only, `worker` starts worker only.
- [ ] **Step 7: Run GREEN** queue/worker/config tests and full suite.
- [ ] **Step 8: Commit:** `feat: add postgres execution queue and worker mode`.

### Task 8: Execution engine with retries, budgets, cancellation, and receipts

**Files:**
- Create: `packages/execution/src/errors.ts`
- Create: `packages/execution/src/budget.ts`
- Create: `packages/execution/src/retry.ts`
- Create: `packages/execution/src/engine.ts`
- Create: `packages/execution/src/receipt.ts`
- Modify: `packages/execution/src/index.ts`
- Test: `packages/execution/test/engine.test.ts`
- Test: `packages/execution/test/retry.test.ts`
- Test: `packages/execution/test/receipt.test.ts`

**Interfaces:**
```ts
interface ExecutionBudget {
  maxSteps: number;
  maxDurationMs: number;
  maxOutputBytes: number;
}

interface ExecuteWorkflowInput {
  ownerId: string;
  projectId: string;
  workflow: ValidatedWorkflow;
  input: ContextEnvelope;
  permissions: ReadonlySet<string>;
  budget: ExecutionBudget;
  traceId: string;
}

interface WorkflowEngine {
  enqueue(input: ExecuteWorkflowInput): Promise<ExecutionRecord>;
  process(executionId: string, signal: AbortSignal): Promise<ExecutionView>;
}
```

- [ ] **Step 1: Write RED engine test** for two-node JSON -> text execution with typed output propagation and provenance edges.
- [ ] **Step 2: Write RED retry tests**: safe tool retry succeeds on later attempt; keyed tool retries with the same key; unsafe tool is attempted once only.
- [ ] **Step 3: Write RED timeout/cancel tests** ensuring AbortSignal reaches tool runtime and final status is `cancelled` or structured `failed`.
- [ ] **Step 4: Write RED budget tests** for step count, total duration, and output-byte overflow before additional work is scheduled.
- [ ] **Step 5: Write RED idempotency test** proving a reclaimed queue lease does not duplicate a completed step with the same execution/node/attempt identity.
- [ ] **Step 6: Write RED receipt test** proving final receipt contains workflow/tool versions, timings, usage, output context IDs, and provenance but excludes secret-like config keys/values.
- [ ] **Step 7: Run RED:** `npm test -w @uw/execution`.
- [ ] **Step 8: Implement minimal engine/retry/budget/receipt behavior** and reuse Tool Registry + Workflow preflight.
- [ ] **Step 9: Run GREEN** execution tests, PostgreSQL integration, and full suite.
- [ ] **Step 10: Commit:** `feat: add durable workflow execution engine`.

### Task 9: Workflow persistence and protected Tool/Workflow/Execution HTTP APIs

**Files:**
- Create: `packages/workflow/src/repository.ts`
- Create: `packages/workflow/src/service.ts`
- Create: `packages/database/src/repositories/workflows.ts`
- Create: `apps/server/src/routes/tools.ts`
- Create: `apps/server/src/routes/workflows.ts`
- Create: `apps/server/src/routes/executions.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/composition.ts`
- Test: `packages/database/test/workflows.integration.test.ts`
- Test: `apps/server/test/workflow-api.integration.test.ts`

**Routes:**
- `GET /api/tools`
- `GET /api/projects/:projectId/workflows`
- `POST /api/projects/:projectId/workflows`
- `GET /api/projects/:projectId/workflows/:workflowId`
- `POST /api/projects/:projectId/workflows/:workflowId/executions`
- `GET /api/projects/:projectId/executions/:executionId`
- `POST /api/projects/:projectId/executions/:executionId/cancel`

**Behavior:**
- Saving a changed workflow creates a new immutable workflow-definition version instead of overwriting execution history.
- Run endpoint performs schema + DAG + permission preflight before enqueue and returns `202` with execution ID.
- No endpoint accepts owner ID/role from the client.
- Routers contain no direct SQL.

- [ ] **Step 1: Write RED workflow repository tests** for owner/project isolation and immutable versioning.
- [ ] **Step 2: Write RED API auth/validation tests** for every route, including cycle/type mismatch -> 400 and missing permission -> 403 without enqueue.
- [ ] **Step 3: Write RED cancellation test** proving only queued/running executions can transition to cancelled.
- [ ] **Step 4: Run RED.**
- [ ] **Step 5: Implement repository/service/routes** through existing trusted owner middleware and request ID trace correlation.
- [ ] **Step 6: Run GREEN** server/database tests and full suite.
- [ ] **Step 7: Commit:** `feat: expose protected workflow execution APIs`.

### Task 10: Mobile-first linear workflow and Run UI

**Files:**
- Create: `apps/web/src/tools/tool-catalog.ts`
- Create: `apps/web/src/workflows/WorkflowList.tsx`
- Create: `apps/web/src/workflows/WorkflowEditor.tsx`
- Create: `apps/web/src/workflows/WorkflowStepEditor.tsx`
- Create: `apps/web/src/executions/RunWorkflow.tsx`
- Create: `apps/web/src/executions/ExecutionStatus.tsx`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/projects/ProjectWorkspace.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/test/phase-3-workflow-flow.test.tsx`
- Test: `apps/web/e2e/workflow-linear.spec.ts`

**UX:**
- Project tab adds **Workflows**.
- Workflow editor is a list of steps; no graph dependency.
- Add Step filters tools using Context Bus-compatible input/output types.
- Every step shows tool name/version, input source, config, timeout/retry summary, and required permissions.
- Reorder has Move Up/Move Down buttons; drag is optional and not required.
- Run screen shows preflight summary before enqueue, then queued/running/completed/failed/cancelled.
- Execution output can be saved as an Artifact only through the existing server/domain boundary.

- [ ] **Step 1: Write RED component tests** for create workflow, add/reorder/remove step, incompatible tool exclusion, visible permission/network preflight, run enqueue, status refresh, failure display, and cancellation.
- [ ] **Step 2: Write RED Playwright flow** creating a project workflow with HTTP -> JSON extraction and completing it against a deterministic in-stack test endpoint.
- [ ] **Step 3: Run RED** component/browser test; failure must be missing Phase 3 UI/API behavior.
- [ ] **Step 4: Implement API client methods and mobile-first components** using existing AuthGate/project shell; do not add a new global state manager or graph library.
- [ ] **Step 5: Run GREEN** component tests, typecheck, production build, and Playwright flow.
- [ ] **Step 6: Commit:** `feat: add linear workflow runner ui`.

### Task 11: Golden workflows, deployment smoke, docs, and Phase 3 gate

**Files:**
- Create: `packages/execution/test/golden-workflows.integration.test.ts`
- Modify: `scripts/smoke-http.mjs`
- Modify: `deploy/docker/compose.yml`
- Modify: `apps/server/Dockerfile`
- Modify: `.github/workflows/ci.yml`
- Create: `docs/architecture/phase-3.md`
- Modify: `docs/runbooks/local-development.md`
- Modify: `README.md`

**Golden workflows implemented in Phase 3:**
1. `HTTP -> JSON extract -> text/markdown transform`
2. `JSON -> transform -> Artifact`
3. `failing HTTP -> retry -> structured Error`

The permanent `HTTP -> JSON -> AI -> Note` golden flow remains Phase 4 because AI is intentionally not part of Phase 3.

- [ ] **Step 1: Write RED golden integration tests** using deterministic local HTTP fixtures; verify outputs, retries, error shapes, receipts, and provenance.
- [ ] **Step 2: Extend Docker smoke RED path** to create owner/project/workflow, execute HTTP -> JSON, wait by bounded status polling, inspect completed receipt, and cancel a second long-running deterministic execution.
- [ ] **Step 3: Add worker/all-mode Docker coverage** with no external internet dependency.
- [ ] **Step 4: Extend CI** with a Phase 3 workflow/browser gate while preserving Phase 2 browser-sync and secret-canary jobs.
- [ ] **Step 5: Update architecture/runbook/README** with package boundaries, queue semantics, runtime modes, workflow limitations, permissions, and troubleshooting.
- [ ] **Step 6: Run the final gate from a clean checkout/fresh PostgreSQL:**
```text
npm ci                                          PASS
npm audit --omit=dev --audit-level=high         PASS
npm run verify:workspaces                       PASS
npm run format:check                            PASS
npm run lint                                    PASS
npm run typecheck                               PASS
npm test                                        PASS
npm run build                                   PASS
node scripts/verify-pwa.mjs                     PASS
Phase 0-2 browser sync regression               PASS
Phase 3 contract/tool/workflow tests            PASS
Phase 3 PostgreSQL migrations                   PASS
Queue lease/reclaim integration                 PASS
Workflow golden integration                     PASS
HTTP egress/redirect security regression        PASS
Linear workflow Chromium E2E                    PASS
Docker Phase 3 vertical smoke                   PASS
Deployment secret-canary scan                   PASS
```
- [ ] **Step 7: Confirm by repository search/log inspection** that no raw password, session token, Authorization header, secret value, or secret-like config value appears in execution rows, queue rows, provenance, receipts, audit rows, error envelopes, or Docker logs.
- [ ] **Step 8: Commit:** `docs: close phase 3 tool workflow core`.
- [ ] **Step 9: Open PR `Phase 3: Tool & Workflow Core` against `main` only after the same head commit has complete green CI evidence.**

## Self-Review

- **Spec coverage:** Tool Contract, Context Bus, DAG model, linear UI, PostgreSQL queue, durable execution state, retry/idempotency, timeout/cancel, budgets, receipts, provenance, initial HTTP/JSON/text/markdown tools, runtime worker mode, golden tests, and Phase 3 deployment are assigned to Tasks 1–11.
- **Deferred intentionally:** AI/provider abstraction and universal Send to remain Phase 4; broader upload/security/backup hardening remains Phase 5; arbitrary loops/shell/code remain non-goals.
- **Placeholder scan:** no task contains TBD/TODO/“similar to”; each implementation step names exact files/interfaces/verification.
- **Type consistency:** ContextEnvelope/ToolDescriptor/WorkflowDefinition/ExecutionStatus from Task 1 are consumed without renaming by Tasks 2–11.
- **Review Focus coverage:** cycle, type mismatch, unsafe retry, blocked redirect, and worker lease-reclaim all have explicit owning tests above.
