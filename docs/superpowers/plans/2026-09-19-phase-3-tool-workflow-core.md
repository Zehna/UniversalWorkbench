# Phase 3 Tool & Workflow Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the trusted Phase 3 execution substrate: typed context, versioned built-in tools, local-first revisioned workflow documents, durable PostgreSQL executions/queue, safe public HTTP, linear-first workflow UI, receipts/provenance, and verified golden workflows.

**Architecture:** Phase 3 adds four domain packages (`@uw/context`, `@uw/tools`, `@uw/execution`, `@uw/workflow`) around existing Action Layer, Documents, Artifacts, Sync, and PostgreSQL adapters. Workflow definitions remain revisioned Documents; actual runs are server-authoritative durable executions claimed from a PostgreSQL queue. Built-in tools all execute through the same engine, with safe HTTP egress below `builtin.http.request@1` and immutable outputs/receipts above the Artifact service.

**Tech Stack:** Node.js 24.21.0, TypeScript 5.9, Zod 4, React 19 + Vite PWA, Express 5, PostgreSQL 17, Drizzle 0.45.2, Vitest 5, Playwright 1.63, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-19-phase-3-tool-workflow-core-design.md`

## Global Constraints

- Keep the repository a modular monolith; domain packages must not import Drizzle or Express.
- Workflow definitions are revisioned Documents with exact pinned `toolId + toolVersion`.
- Workflow editing remains local-first; workflow execution is online/server-authoritative in Phase 3.
- `APP_MODE` must support exactly `all | api | worker` after this phase.
- Phase 3 queue implementation is PostgreSQL only; do not add Redis.
- Phase 3 HTTP Tool supports real public HTTP, but deny-by-default safe egress is mandatory before product use.
- Phase 3 public HTTP must not accept raw secrets, URL userinfo, credential-like query parameters, Authorization/Cookie/Proxy-Authorization, or API-key-style headers.
- No AI provider, AI Tool, secret vault, MCP/plugin runtime, arbitrary JavaScript/shell execution, graph editor, cycles, arbitrary loops, scheduled runs, or unrestricted LAN HTTP.
- All state-changing server paths must keep server-authoritative ownership/authorization and existing Action Layer boundaries.
- Raw credentials must never appear in receipts, provenance, operation journals, execution logs, persisted URLs, or deployment smoke logs.
- Automatic retries are capped at 3 attempts; ambiguous non-idempotent HTTP writes are not retried automatically.
- Inline text/JSON context is capped at 1 MiB serialized; HTTP response bodies are capped at 5 MiB and stored as immutable Artifacts.
- Existing Phase 0–2 test, browser-sync, PWA, and Docker gates must remain green.

## Review Focus

1. **Workflow version drift:** an existing workflow revision must keep executing its exact pinned tool version even after another tool version is registered. Task 2 pins this with registry-resolution tests and Task 11 exercises it through HTTP execution routes.
2. **Foreign or unsynced workflow revision:** a client must not execute a local-only/conflicted workflow revision that the server cannot identify canonically. Task 4 adds canonical-revision enforcement tests; Task 12 covers the disabled Run UX.
3. **Unsafe redirect/DNS rebinding:** an initially public HTTP URL must still fail if DNS or any redirect hop resolves to blocked/private metadata space. Task 9 owns pinned-address and redirect security regressions.
4. **Ambiguous worker retry:** POST/PATCH/DELETE must not be replayed after an ambiguous network failure unless the runner explicitly proves replay safety. Task 8 owns retry classifier tests and Task 9 adds HTTP-method cases.
5. **Worker crash/lease expiry:** an abandoned queue lease must become claimable again without duplicating a side effect or terminal receipt. Task 7 owns PostgreSQL lease-reclaim integration tests and Task 10 verifies step idempotency on reclaimed work.

---

### Task 1: Phase 3 Workspaces and Runtime Contracts

**Files:**
- Create: `packages/context/package.json`
- Create: `packages/context/tsconfig.json`
- Create: `packages/context/src/index.ts`
- Create: `packages/tools/package.json`
- Create: `packages/tools/tsconfig.json`
- Create: `packages/tools/src/index.ts`
- Create: `packages/execution/package.json`
- Create: `packages/execution/tsconfig.json`
- Create: `packages/execution/src/index.ts`
- Create: `packages/workflow/package.json`
- Create: `packages/workflow/tsconfig.json`
- Create: `packages/workflow/src/index.ts`
- Create: `packages/contracts/src/context.ts`
- Create: `packages/contracts/src/tool.ts`
- Create: `packages/contracts/src/execution.ts`
- Create: `packages/contracts/src/workflow.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `scripts/verify-workspaces.mjs`
- Modify: `package.json`
- Test: `packages/contracts/test/phase-3-contracts.test.ts`

**Interfaces:**
- Consumes: existing `IdSchema`, `IsoDateTimeSchema`, Zod, JSON-safe metadata.
- Produces:
  - `ContextEnvelopeSchema`, `ContextTypeSchema`, `ContextCapabilitySchema`
  - `ToolDefinitionSchema`, `ToolCapabilitySchema`, `ToolExecutionModeSchema`
  - `ExecutionSchema`, `ExecutionBudgetSchema`, `ExecutionStatusSchema`, `ExecutionReceiptSchema`
  - `WorkflowDefinitionV1Schema`, `WorkflowNodeSchema`, `WorkflowEdgeSchema`
  - four buildable Phase 3 workspaces.

- [ ] **Step 1: Write failing contract tests**

Create `packages/contracts/test/phase-3-contracts.test.ts` with cases equivalent to:

```ts
import { describe, expect, it } from "vitest";
import {
  ContextEnvelopeSchema,
  ToolDefinitionSchema,
  ExecutionBudgetSchema,
  WorkflowDefinitionV1Schema,
} from "../src/index.js";

describe("Phase 3 contracts", () => {
  it("accepts a versioned json context envelope", () => {
    expect(
      ContextEnvelopeSchema.parse({
        id: "11111111-1111-4111-8111-111111111111",
        type: "json",
        schemaVersion: 1,
        mimeType: "application/json",
        metadata: {},
        payload: { ok: true },
        provenance: {
          projectId: "22222222-2222-4222-8222-222222222222",
          artifactIds: [],
          parentContextIds: [],
        },
        capabilities: [],
      }).type,
    ).toBe("json");
  });

  it("rejects a tool without an exact version", () => {
    expect(() =>
      ToolDefinitionSchema.parse({
        id: "builtin.json.select",
        version: "",
        displayName: "JSON Select",
        description: "Select JSON Pointer",
        executionMode: "worker",
        accepts: [],
        produces: [],
        config: {},
        requiredCapabilities: [],
        defaults: { timeoutMs: 5000, maxAttempts: 1 },
      }),
    ).toThrow();
  });

  it("rejects a zero-step execution budget", () => {
    expect(() =>
      ExecutionBudgetSchema.parse({
        maxWallClockMs: 60000,
        maxSteps: 0,
        maxAttemptsPerStep: 1,
        maxTotalAttempts: 1,
        maxOutputBytes: 1048576,
        maxHttpRequests: 1,
      }),
    ).toThrow();
  });

  it("requires exact tool version pins in workflow nodes", () => {
    expect(() =>
      WorkflowDefinitionV1Schema.parse({
        schemaVersion: 1,
        name: "Broken",
        nodes: [{ id: "a", tool: { id: "builtin.json.select" }, config: {} }],
        edges: [],
        outputs: [],
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the contract suite and verify RED**

Run:

```bash
npm run test -w @uw/contracts -- phase-3-contracts.test.ts
```

Expected: FAIL because the Phase 3 exports/schemas do not exist.

- [ ] **Step 3: Add the four workspace manifests**

Each workspace must follow existing package conventions. Example `packages/context/package.json`:

```json
{
  "name": "@uw/context",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "build": "tsup src/index.ts --format esm --dts --clean"
  },
  "dependencies": {
    "@uw/contracts": "*",
    "zod": "^4.0.0"
  }
}
```

Use analogous manifests for `@uw/tools`, `@uw/execution`, and `@uw/workflow`, adding only dependencies that each package actually consumes.

- [ ] **Step 4: Implement runtime contracts**

Define these exact Phase 3 vocabularies:

```ts
export const ContextTypeSchema = z.enum([
  "text",
  "markdown",
  "json",
  "api-response",
  "artifact-ref",
  "note-ref",
  "error",
]);

export const ToolCapabilitySchema = z.enum([
  "network.public",
  "project.documents.read",
  "project.documents.write",
  "project.artifacts.read",
  "project.artifacts.write",
]);

export const ExecutionStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);
```

Define workflow nodes with exact `tool.id` and non-empty `tool.version`. Export all four contract modules from `packages/contracts/src/index.ts`.

- [ ] **Step 5: Update workspace/build order**

Add the four new package manifests to `scripts/verify-workspaces.mjs`.

Update root `build` so dependency order is:

```text
contracts -> shared -> auth -> core -> context -> tools -> workflow ->
execution -> sync -> documents -> storage -> artifacts -> database ->
server -> web
```

Refresh only the lockfile after manifest changes.

- [ ] **Step 6: Verify Task 1**

Run:

```bash
npm install --package-lock-only --ignore-scripts
npm run verify:workspaces
npm run test -w @uw/contracts -- phase-3-contracts.test.ts
npm run typecheck -w @uw/contracts
npm run build -w @uw/context
npm run build -w @uw/tools
npm run build -w @uw/workflow
npm run build -w @uw/execution
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json scripts/verify-workspaces.mjs packages/contracts packages/context packages/tools packages/workflow packages/execution
git commit -m "feat: establish phase 3 execution contracts"
```

---

### Task 2: Context Bus, Tool Contract, and Deterministic Registry

**Files:**
- Create: `packages/context/src/envelope.ts`
- Create: `packages/context/src/compatibility.ts`
- Create: `packages/context/src/registry.ts`
- Create: `packages/context/test/compatibility.test.ts`
- Create: `packages/tools/src/contract.ts`
- Create: `packages/tools/src/registry.ts`
- Create: `packages/tools/src/errors.ts`
- Create: `packages/tools/src/permissions.ts`
- Create: `packages/tools/test/registry.test.ts`
- Modify: `packages/context/src/index.ts`
- Modify: `packages/tools/src/index.ts`

**Interfaces:**
- Consumes: Task 1 context/tool contracts.
- Produces:
  - `ContextCompatibilityRegistry`
  - `ToolRunner`, `ToolRunContext`, `ToolRunResult`
  - `ToolRegistry.register(definition, runner)`
  - `ToolRegistry.resolve(id, version)`
  - `ToolRegistry.compatibleTargets(contextType)`
  - `ToolRegistry.requiredCapabilities(id, version)`.

- [ ] **Step 1: Write RED compatibility/registry tests**

Pin exact-type compatibility, explicit adapter compatibility, duplicate ID/version rejection, and version drift:

```ts
it("resolves the exact pinned version after a newer version is registered", () => {
  registry.register(definition("builtin.text.template", "1"), runnerV1);
  registry.register(definition("builtin.text.template", "2"), runnerV2);

  expect(registry.resolve("builtin.text.template", "1").runner).toBe(runnerV1);
});
```

Also verify an unregistered `json -> note.write` path is not implicitly accepted.

- [ ] **Step 2: Run RED**

```bash
npm run test -w @uw/context
npm run test -w @uw/tools
```

Expected: FAIL because implementation modules do not exist.

- [ ] **Step 3: Implement context compatibility**

Use explicit port declarations:

```ts
export interface ContextPort {
  name: string;
  types: ContextType[];
  required: boolean;
}

export function acceptsContext(port: ContextPort, type: ContextType): boolean {
  return port.types.includes(type);
}
```

Allow explicitly registered adapters, but do not add fuzzy conversion.

- [ ] **Step 4: Implement Tool Contract runtime interfaces**

```ts
export interface ToolRunContext {
  ownerId: string;
  projectId: string;
  executionId: string;
  stepExecutionId: string;
  traceId: string;
  config: unknown;
  inputs: Record<string, ContextEnvelope>;
  signal: AbortSignal;
}

export interface ToolRunResult {
  outputs: Record<string, ContextEnvelope>;
  usage: {
    outputBytes: number;
    httpRequests: number;
  };
}

export interface ToolRunner {
  run(context: ToolRunContext): Promise<ToolRunResult>;
}
```

- [ ] **Step 5: Implement deterministic Tool Registry**

Reject duplicate `id@version`. Never choose a version implicitly for workflow execution. Compatibility queries may return all registered versions, but execution resolution requires both exact values.

- [ ] **Step 6: Verify Task 2**

```bash
npm run test -w @uw/context
npm run test -w @uw/tools
npm run typecheck -w @uw/context
npm run typecheck -w @uw/tools
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/context packages/tools
git commit -m "feat: add context bus and tool registry"
```

---

### Task 3: Workflow Model, DAG Validation, Bindings, and Planning

**Files:**
- Create: `packages/workflow/src/model.ts`
- Create: `packages/workflow/src/validate.ts`
- Create: `packages/workflow/src/bindings.ts`
- Create: `packages/workflow/src/planner.ts`
- Create: `packages/workflow/src/errors.ts`
- Create: `packages/workflow/test/validate.test.ts`
- Create: `packages/workflow/test/planner.test.ts`
- Modify: `packages/workflow/src/index.ts`

**Interfaces:**
- Consumes: Task 1 Workflow contracts and Task 2 `ToolRegistry`.
- Produces:
  - `validateWorkflowDefinition(definition, registry, allowedCapabilities, budget)`
  - `buildWorkflowPlan(definition)`
  - `bindNodeInputs(nodeId, edges, outputs)`
  - deterministic topological order and dependency counts.

- [ ] **Step 1: Write failing graph validation tests**

Include:

- duplicate node IDs;
- missing tool version;
- missing port;
- incompatible context type;
- self-loop;
- multi-node cycle;
- no terminal output/side-effect;
- capability denied;
- static `maxSteps` budget exceeded;
- valid branched DAG.

Review Focus cycle case:

```ts
it("rejects a cycle even when every port type is compatible", () => {
  const result = validateWorkflowDefinition(cyclicDefinition, registry, allowed, budget);
  expect(result.ok).toBe(false);
  expect(result.errors).toContainEqual(
    expect.objectContaining({ code: "WORKFLOW_CYCLE" }),
  );
});
```

- [ ] **Step 2: Run RED**

```bash
npm run test -w @uw/workflow
```

Expected: FAIL because validator/planner do not exist.

- [ ] **Step 3: Implement deterministic validation**

Use Kahn topological sorting. Never mutate the input definition. Return structured validation errors:

```ts
export interface WorkflowValidationError {
  code:
    | "DUPLICATE_NODE"
    | "UNKNOWN_TOOL"
    | "UNKNOWN_PORT"
    | "TYPE_MISMATCH"
    | "MISSING_INPUT"
    | "WORKFLOW_CYCLE"
    | "NO_TERMINAL"
    | "CAPABILITY_DENIED"
    | "BUDGET_EXCEEDED";
  nodeId?: string;
  message: string;
}
```

- [ ] **Step 4: Implement planning and bindings**

`buildWorkflowPlan` returns:

```ts
interface WorkflowPlan {
  order: string[];
  roots: string[];
  terminals: string[];
  dependencies: Record<string, string[]>;
  dependents: Record<string, string[]>;
}
```

`bindNodeInputs` must fail closed when required upstream output is absent.

- [ ] **Step 5: Verify Task 3**

```bash
npm run test -w @uw/workflow
npm run typecheck -w @uw/workflow
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/workflow
git commit -m "feat: validate and plan typed workflows"
```

---

### Task 4: Generalize Revisioned Documents and Local-First Sync for Workflows

**Files:**
- Modify: `packages/contracts/src/document.ts`
- Modify: `packages/contracts/src/sync.ts`
- Modify: `packages/documents/src/model.ts`
- Modify: `packages/documents/src/repository.ts`
- Modify: `packages/documents/src/service.ts`
- Modify: `packages/database/src/repositories/documents.ts`
- Modify: `packages/database/src/repositories/sync.ts`
- Modify: `apps/web/src/local/store.ts`
- Modify: `apps/web/src/local/mutations.ts`
- Modify: `apps/web/src/local/indexeddb-store.ts`
- Modify: `apps/web/src/local/sqlite-store.ts`
- Modify: `apps/web/src/local/sqlite-worker.ts`
- Modify: `apps/web/src/sync/coordinator.ts`
- Test: `packages/documents/test/workflow-documents.test.ts`
- Test: `packages/database/test/workflow-documents.integration.test.ts`
- Test: `apps/web/test/workflow-local-mutations.test.ts`

**Interfaces:**
- Consumes: `WorkflowDefinitionV1` from Task 1 and validator from Task 3.
- Produces:
  - `DocumentKind = "note" | "workflow"`
  - discriminated `DocumentRevisionContent`
  - `WorkflowDocumentView`
  - `DocumentService.createWorkflow/updateWorkflow/listWorkflows/getWorkflow`
  - local `upsertWorkflow`, `listWorkflows`, `getWorkflow`
  - sync payloads for workflow create/update/delete.

- [ ] **Step 1: Write RED document/local-store tests**

Pin:

- note behavior unchanged;
- workflow revision stores `{ workflow: WorkflowDefinitionV1 }`;
- update requires `baseRevisionId`;
- stale workflow update returns conflict;
- workflow local mutation survives IndexedDB/SQLite reload;
- unsynced workflow operation stays pending after reload.

- [ ] **Step 2: Run focused RED suites**

```bash
npm run test -w @uw/documents -- workflow-documents.test.ts
npm run test -w @uw/database -- workflow-documents.integration.test.ts
npm run test -w @uw/web -- workflow-local-mutations.test.ts
```

Expected: FAIL because workflow document APIs/storage do not exist.

- [ ] **Step 3: Generalize document contracts without weakening note schemas**

Use discriminated revision content:

```ts
export const NoteRevisionContentSchema = z.object({
  kind: z.literal("note"),
  body: z.string(),
});

export const WorkflowRevisionContentSchema = z.object({
  kind: z.literal("workflow"),
  workflow: WorkflowDefinitionV1Schema,
});
```

Migration compatibility: existing note rows that currently persist `{ body }` must continue reading correctly. Add an explicit legacy-note normalizer in repository mapping rather than breaking Phase 1/2 data.

- [ ] **Step 4: Extend document service/repository**

Add workflow-specific methods. Validate workflow definitions before save through a validator dependency injected into the workflow service boundary; do not let the repository make domain validation decisions.

- [ ] **Step 5: Extend sync document apply**

Support:

```text
workflow.create
workflow.update
workflow.delete
```

or keep the entity type `document` with document actions carrying a discriminated workflow payload, but choose exactly one convention and encode it in contracts/tests. Preserve compare-and-swap and tombstones.

- [ ] **Step 6: Extend both browser local backends**

Add workflow object stores/tables only if required; prefer reuse of existing `documents` and `document_revisions` stores with discriminated content.

- [ ] **Step 7: Add canonical-execution preflight**

Expose a document-service method:

```ts
assertCanonicalWorkflowRevision(
  ownerId: string,
  projectId: string,
  workflowId: string,
  revisionId: string,
): Promise<WorkflowDocumentView>;
```

It must fail if the revision is not current canonical server state. This is the server guard for Review Focus #2.

- [ ] **Step 8: Verify Task 4**

Run the focused suites, then:

```bash
npm run test -w @uw/documents
TEST_DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm run test -w @uw/database
npm run test -w @uw/web
```

Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts packages/documents packages/database apps/web/src/local apps/web/src/sync apps/web/test
git commit -m "feat: add local-first workflow documents"
```

---

### Task 5: Durable Execution Domain and PostgreSQL Schema

**Files:**
- Create: `packages/execution/src/model.ts`
- Create: `packages/execution/src/repository.ts`
- Create: `packages/execution/src/receipt.ts`
- Create: `packages/execution/src/budget.ts`
- Create: `packages/execution/src/errors.ts`
- Create: `packages/execution/test/model.test.ts`
- Modify: `packages/execution/src/index.ts`
- Modify: `packages/database/src/schema.ts`
- Create: generated Drizzle migration under `packages/database/drizzle/`
- Create: `packages/database/test/phase-3-migration.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 execution contracts.
- Produces:
  - `ExecutionRepository`
  - `ExecutionReceiptRepository`
  - `ProvenanceRepository`
  - Phase 3 tables:
    `executions`, `execution_steps`, `execution_outputs`,
    `execution_receipts`, `execution_queue`, `provenance_edges`.

- [ ] **Step 1: Write RED model/migration tests**

Contract state-machine tests must reject terminal -> running regression:

```ts
expect(canTransition("succeeded", "running")).toBe(false);
expect(canTransition("cancelled", "queued")).toBe(false);
```

PostgreSQL integration tests verify:

- one idempotency key per owner/project/kind;
- execution status check constraint;
- step status check constraint;
- immutable receipt identity;
- provenance FKs;
- queue availability/lease indexes;
- migration is idempotent.

- [ ] **Step 2: Run RED**

```bash
npm run test -w @uw/execution
TEST_DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm run test -w @uw/database -- phase-3-migration.integration.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement execution domain interfaces**

Define mutable lifecycle separately from immutable receipt data. Keep Drizzle types out of `@uw/execution`.

- [ ] **Step 4: Add database schema and indexes**

Required unique key:

```text
(owner_id, project_id, kind, idempotency_key)
```

Queue index must support:

```text
available_at <= now AND (lease_expires_at IS NULL OR lease_expires_at < now)
```

- [ ] **Step 5: Generate explicit Drizzle migration**

Run:

```bash
npx drizzle-kit generate --config=packages/database/drizzle.config.ts
```

Do not hand-edit generated snapshot metadata except formatting exclusions already established by the repo.

- [ ] **Step 6: Verify Task 5**

```bash
npm run test -w @uw/execution
TEST_DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm run test -w @uw/database -- phase-3-migration.integration.test.ts
npm run migrate -w @uw/database
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/execution packages/database
git commit -m "feat: add durable execution schema"
```

---

### Task 6: PostgreSQL Execution Repositories, Idempotent Enqueue, Receipts, and Provenance

**Files:**
- Create: `packages/database/src/repositories/executions.ts`
- Create: `packages/database/src/repositories/execution-receipts.ts`
- Create: `packages/database/src/repositories/provenance.ts`
- Modify: `packages/database/src/index.ts`
- Create: `packages/database/test/executions.integration.test.ts`
- Create: `packages/execution/src/service.ts`
- Create: `packages/execution/test/service.test.ts`
- Modify: `packages/execution/src/index.ts`

**Interfaces:**
- Consumes: Task 5 repository ports/schema.
- Produces:
  - `createPostgresExecutionRepository(pool)`
  - `createPostgresExecutionReceiptRepository(pool)`
  - `createPostgresProvenanceRepository(pool)`
  - `createExecutionService(...)`
  - idempotent `enqueueToolExecution` / `enqueueWorkflowExecution`
  - cancellation request and execution queries.

- [ ] **Step 1: Write RED idempotency/lifecycle integration tests**

Pin same-key behavior:

```ts
const first = await service.enqueueWorkflowExecution(input);
const duplicate = await service.enqueueWorkflowExecution(input);
expect(duplicate.id).toBe(first.id);
expect(await repository.countByIdempotencyKey(...)).toBe(1);
```

Also verify another project/owner may reuse the same key without collision.

- [ ] **Step 2: Run RED**

```bash
TEST_DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm run test -w @uw/database -- executions.integration.test.ts
npm run test -w @uw/execution -- service.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement PostgreSQL adapters**

Use transactions for create execution + initial step/job rows. Duplicate unique-key insert returns the existing execution rather than surfacing a 500.

- [ ] **Step 4: Implement cancellation request semantics**

Cancellation only sets `cancellationRequestedAt` for non-terminal execution. A terminal execution returns unchanged.

- [ ] **Step 5: Implement immutable receipt/provenance writes**

Repository API must have only append/read operations for receipts and provenance. No update/delete method in domain port.

- [ ] **Step 6: Verify Task 6**

Run focused tests and full `@uw/execution` + `@uw/database` suites.

- [ ] **Step 7: Commit**

```bash
git add packages/execution packages/database
git commit -m "feat: persist executions receipts and provenance"
```

---

### Task 7: PostgreSQL Queue with Claim, Lease, Reclaim, and Worker-Safe Completion

**Files:**
- Create: `packages/execution/src/queue.ts`
- Create: `packages/database/src/repositories/execution-queue.ts`
- Modify: `packages/database/src/index.ts`
- Create: `packages/database/test/execution-queue.integration.test.ts`
- Modify: `packages/execution/src/index.ts`

**Interfaces:**
- Consumes: Task 5 queue schema.
- Produces:
  - `ExecutionQueue`
  - `QueueJob`
  - `claim(workerId, now, leaseMs)`
  - `complete(jobId, workerId)`
  - `releaseForRetry(jobId, workerId, availableAt, attempt)`
  - `abandon(jobId, workerId)`
  - `createPostgresExecutionQueue(pool)`.

- [ ] **Step 1: Write RED real-Postgres queue tests**

Required tests:

1. two concurrent claimers cannot claim the same job;
2. `available_at` prevents early claim;
3. active unexpired lease prevents a second claim;
4. expired lease becomes claimable by another worker;
5. wrong worker cannot complete another worker's lease;
6. cancellation prevents new claim;
7. reclaimed job keeps the same execution/step identity.

Use two actual PostgreSQL connections for the concurrency case.

- [ ] **Step 2: Run RED**

```bash
TEST_DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm run test -w @uw/database -- execution-queue.integration.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement atomic claim**

Claim SQL must use a transaction and `FOR UPDATE SKIP LOCKED`. The selected row is updated with `lease_owner` and `lease_expires_at` before commit.

- [ ] **Step 4: Implement completion/retry/reclaim guards**

All lease mutations must match both `job_id` and `lease_owner`.

- [ ] **Step 5: Verify Task 7**

Run focused test repeatedly:

```bash
for i in 1 2 3; do TEST_DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm run test -w @uw/database -- execution-queue.integration.test.ts || exit 1; done
```

Expected: PASS three times with no duplicate claims.

- [ ] **Step 6: Commit**

```bash
git add packages/execution packages/database
git commit -m "feat: add postgres execution queue"
```

---

### Task 8: Retry Taxonomy, Budgets, Cancellation, and Engine State Machine

**Files:**
- Create: `packages/execution/src/retry.ts`
- Create: `packages/execution/src/engine.ts`
- Create: `packages/execution/src/worker.ts`
- Modify: `packages/execution/src/budget.ts`
- Modify: `packages/execution/src/errors.ts`
- Create: `packages/execution/test/retry.test.ts`
- Create: `packages/execution/test/engine.test.ts`
- Create: `packages/execution/test/worker.test.ts`

**Interfaces:**
- Consumes: Task 2 Tool Registry, Task 6 repositories, Task 7 queue.
- Produces:
  - `classifyToolFailure(error, retryContext)`
  - `computeRetryDelay(attempt, retryAfterMs?)`
  - `ExecutionEngine.runClaimedJob(job, signal)`
  - `ExecutionWorker.start()/stop()`.

- [ ] **Step 1: Write RED retry/budget tests**

Pin taxonomy:

```ts
expect(classify({ code: "UPSTREAM_5XX", method: "GET" }).retryable).toBe(true);
expect(classify({ code: "NETWORK_TRANSIENT", method: "POST", ambiguous: true }).retryable).toBe(false);
expect(classify({ code: "UNSAFE_EGRESS", method: "GET" }).retryable).toBe(false);
```

Also test max attempts = 3, bounded Retry-After, output bytes, HTTP request count, total attempts, and cancellation before retry.

- [ ] **Step 2: Write RED worker/engine tests**

Use fake repositories/queue/tool runner to pin:

- queued -> running -> succeeded;
- cancellation request before start -> cancelled without tool run;
- AbortSignal timeout -> timed_out;
- retryable failure -> queue release with future `availableAt`;
- budget exceeded -> terminal `BUDGET_EXCEEDED`;
- terminal receipt exactly once.

- [ ] **Step 3: Run RED**

```bash
npm run test -w @uw/execution
```

Expected: FAIL.

- [ ] **Step 4: Implement retry/budget policy**

Use deterministic dependency-injected jitter source in tests; production may use `Math.random`, but tests must not depend on timing randomness.

- [ ] **Step 5: Implement engine state transitions**

Before invoking a runner:

1. re-read execution;
2. stop on cancellation;
3. verify budget;
4. mark running transactionally;
5. execute with AbortController;
6. persist outputs/usage;
7. complete/retry/fail;
8. append immutable receipt only for terminal outcome.

- [ ] **Step 6: Verify Task 8**

```bash
npm run test -w @uw/execution
npm run typecheck -w @uw/execution
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/execution
git commit -m "feat: add execution engine retry and budgets"
```

---

### Task 9: Safe Public HTTP Transport and `builtin.http.request@1`

**Files:**
- Create: `packages/tools/src/builtin/http/policy.ts`
- Create: `packages/tools/src/builtin/http/dns.ts`
- Create: `packages/tools/src/builtin/http/transport.ts`
- Create: `packages/tools/src/builtin/http/tool.ts`
- Create: `packages/tools/test/http-policy.test.ts`
- Create: `packages/tools/test/http-transport.test.ts`
- Create: `packages/tools/test/http-tool.test.ts`
- Modify: `packages/tools/src/index.ts`
- Modify: `packages/tools/package.json`

**Interfaces:**
- Consumes: Task 2 ToolRunner contract and Artifact service adapter supplied at composition time.
- Produces:
  - `SafeEgressPolicy.validateUrl(url)`
  - `SafeDnsResolver.resolvePublic(hostname)`
  - `SafeHttpTransport.request(...)`
  - `createHttpRequestTool(...)`
  - built-in definition `builtin.http.request@1`.

- [ ] **Step 1: Write RED egress policy tests**

Must include:

- `127.0.0.1`;
- `0.0.0.0`;
- `10.0.0.1`;
- `172.16.0.1`;
- `192.168.1.1`;
- `169.254.169.254`;
- carrier-grade NAT;
- `::1`;
- IPv6 link-local;
- IPv4-mapped IPv6 blocked addresses;
- URL userinfo;
- `file:`, `ftp:`;
- credential-like query keys such as `api_key`, `token`, `password`;
- Authorization/Cookie/Proxy-Authorization and API-key-style request headers.

- [ ] **Step 2: Write RED transport security tests**

Inject a deterministic resolver/connector. Pin:

- hostname with one public + one private DNS result => reject;
- first hop public, redirect to private => reject;
- DNS resolves public during validation but would later change private => connector still uses the validated pinned address;
- no ambient proxy env is read;
- Set-Cookie is absent from persisted safe headers;
- response > 5 MiB => `OUTPUT_TOO_LARGE`;
- timeout => `TIMEOUT`.

- [ ] **Step 3: Run RED**

```bash
npm run test -w @uw/tools -- http-policy.test.ts http-transport.test.ts http-tool.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Add an IP classification dependency only if necessary**

Prefer a small maintained library with explicit IPv4/IPv6 classification. If added, pin exact dependency via lockfile and run production audit before proceeding.

Do not implement policy with string prefixes.

- [ ] **Step 5: Implement safe DNS + pinned connection transport**

The resolver returns validated addresses. The transport connector must connect to the chosen validated IP while preserving original hostname for Host/SNI.

Redirects call the same validation pipeline from the beginning.

- [ ] **Step 6: Implement HTTP Tool**

Runner creates an immutable response-body Artifact and outputs an `api-response` context with:

```ts
{
  status,
  headers: safeHeaders,
  url: sanitizedFinalUrl,
  bodyArtifactId,
  bodyMimeType,
  bodySizeBytes
}
```

No body bytes are stored in the context envelope.

- [ ] **Step 7: Verify Task 9**

```bash
npm run test -w @uw/tools
npm run typecheck -w @uw/tools
npm audit --omit=dev --audit-level=high
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/tools package-lock.json
git commit -m "feat: add safe public http tool"
```

---

### Task 10: JSON, Text, Note Built-ins and Output Persistence

**Files:**
- Create: `packages/tools/src/builtin/json/parse.ts`
- Create: `packages/tools/src/builtin/json/select.ts`
- Create: `packages/tools/src/builtin/text/template.ts`
- Create: `packages/tools/src/builtin/note/write.ts`
- Create: `packages/tools/test/json-tools.test.ts`
- Create: `packages/tools/test/text-template.test.ts`
- Create: `packages/tools/test/note-write.test.ts`
- Modify: `packages/tools/src/index.ts`
- Modify: `packages/execution/src/engine.ts`
- Test: `packages/execution/test/step-idempotency.test.ts`

**Interfaces:**
- Consumes: ToolRunner, ArtifactService, DocumentService.
- Produces built-ins:
  - `builtin.json.parse@1`
  - `builtin.json.select@1`
  - `builtin.text.template@1`
  - `builtin.note.write@1`
  - deterministic step-side-effect idempotency guard.

- [ ] **Step 1: Write RED JSON/Text tests**

Pin JSON Pointer RFC-style behavior for root, escaped `~0/~1`, missing pointer structured validation error, and no expression evaluation.

Template syntax is only:

```text
{{input}}
{{json:/pointer}}
```

Unknown placeholders fail validation; there is no JavaScript/eval.

- [ ] **Step 2: Write RED Note Tool tests**

Inject a fake `DocumentService`. Verify:

- only text/markdown accepted;
- existing project ownership is checked through DocumentService;
- retrying the same `stepExecutionId` does not create a second note;
- the runner never receives a database repository.

- [ ] **Step 3: Implement deterministic tools**

`json.parse` loads Artifact bytes when the input is `api-response`, validates UTF-8 JSON, and outputs `json`.

`json.select` outputs selected JSON.

`text.template` outputs text/markdown.

- [ ] **Step 4: Implement Note runner through Action Layer-backed service**

Add an execution-side-effect repository/record if needed to associate `stepExecutionId -> noteId`; do not rely on in-memory deduplication.

- [ ] **Step 5: Persist immutable output snapshots**

The engine must persist tool outputs as immutable execution outputs/Artifacts before marking a step succeeded so downstream bindings and receipts reference durable data.

- [ ] **Step 6: Verify Task 10**

```bash
npm run test -w @uw/tools
npm run test -w @uw/execution
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/tools packages/execution packages/database
git commit -m "feat: add json text and note tools"
```

---

### Task 11: Workflow Service and Execution Orchestration

**Files:**
- Create: `packages/workflow/src/service.ts`
- Create: `packages/workflow/test/service.test.ts`
- Modify: `packages/workflow/src/index.ts`
- Modify: `packages/execution/src/engine.ts`
- Create: `packages/execution/test/workflow-engine.test.ts`

**Interfaces:**
- Consumes: Task 3 validator/planner, Task 4 canonical workflow guard, Task 6 ExecutionService, Task 8 engine.
- Produces:
  - `WorkflowService.validateRevision(...)`
  - `WorkflowService.enqueueRun(...)`
  - fail-fast DAG step scheduling;
  - downstream input binding and provenance.

- [ ] **Step 1: Write RED canonical revision tests**

Pin:

- local-only revision ID rejected;
- stale server revision rejected;
- current canonical synced revision accepted;
- conflicted workflow cannot enqueue.

- [ ] **Step 2: Write RED workflow engine tests**

Use a branched DAG:

```text
root
 |-- json.select A --|
 |-- json.select B --|-> text.template -> note.write
```

Verify independent ready nodes may be queued concurrently and terminal receipt completes only after all reachable nodes are terminal.

- [ ] **Step 3: Implement WorkflowService preflight**

Order:

1. fetch canonical workflow revision;
2. runtime-parse definition;
3. validate exact tools/config/ports/types/cycle/capabilities/budget;
4. enqueue idempotent execution + step rows.

- [ ] **Step 4: Implement fail-fast scheduling**

On failed terminal step:

- mark dependent unstarted nodes `skipped`;
- do not queue new dependents;
- fail workflow execution after all already-running independent steps settle or are cooperatively cancelled.

- [ ] **Step 5: Add provenance edges**

When outputs are bound downstream, append source-output -> target-output/context provenance edges with execution and step IDs.

- [ ] **Step 6: Verify Task 11**

```bash
npm run test -w @uw/workflow
npm run test -w @uw/execution
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/workflow packages/execution
git commit -m "feat: orchestrate durable workflow runs"
```

---

### Task 12: Runtime Modes, Composition Root, Worker Lifecycle, and Protected HTTP API

**Files:**
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/composition.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/app.ts`
- Create: `apps/server/src/worker-runtime.ts`
- Create: `apps/server/src/routes/tools.ts`
- Create: `apps/server/src/routes/workflows.ts`
- Create: `apps/server/src/routes/executions.ts`
- Create: `apps/server/test/runtime-mode.test.ts`
- Create: `apps/server/test/tools.integration.test.ts`
- Create: `apps/server/test/workflows.integration.test.ts`
- Create: `apps/server/test/executions.integration.test.ts`
- Modify: `apps/server/package.json`

**Interfaces:**
- Consumes: all Phase 3 services/runners.
- Produces:
  - `APP_MODE: "all" | "api" | "worker"`
  - routes from spec §28;
  - worker lifecycle and graceful shutdown.

- [ ] **Step 1: Write RED runtime-mode tests**

Pin:

- `loadConfig({ APP_MODE: "worker" })` accepted;
- worker mode does not call `server.listen`;
- api mode does not start worker loop;
- all mode does both;
- shutdown stops worker before closing pool.

Refactor startup into testable `startRuntime(config)` rather than importing a side-effectful module in tests.

- [ ] **Step 2: Write RED protected-route tests**

Test auth + ownership for:

```text
GET /tools
POST /tools/compatibility
/workflows...
/executions...
```

No request schema accepts `ownerId`.

- [ ] **Step 3: Implement composition**

Register only the five trusted built-in tool versions from Tasks 9–10.

Wire execution repositories/queue/worker/services.

- [ ] **Step 4: Implement routes with Zod schemas**

Execution create request must include client idempotency key and either:

```ts
{ kind: "tool", tool: { id, version }, ... }
```

or:

```ts
{ kind: "workflow", workflowId, workflowRevisionId, ... }
```

- [ ] **Step 5: Implement mode-specific runtime**

`worker` starts no HTTP/WebSocket server.

`api` has no worker loop.

`all` starts both.

- [ ] **Step 6: Verify Task 12**

```bash
npm run test -w @uw/server
npm run typecheck -w @uw/server
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server
git commit -m "feat: expose phase 3 execution runtime"
```

---

### Task 13: Linear-First Workflow UI and Context Compatibility UX

**Files:**
- Create: `apps/web/src/workflows/WorkflowList.tsx`
- Create: `apps/web/src/workflows/WorkflowEditor.tsx`
- Create: `apps/web/src/workflows/WorkflowStepEditor.tsx`
- Create: `apps/web/src/workflows/ExecutionTimeline.tsx`
- Create: `apps/web/src/workflows/api.ts`
- Create: `apps/web/src/context/CompatibleTargets.tsx`
- Modify: `apps/web/src/projects/ProjectWorkspace.tsx`
- Modify: `apps/web/src/local/store.ts`
- Modify: `apps/web/src/sync/coordinator.ts`
- Test: `apps/web/test/workflow-editor.test.tsx`
- Test: `apps/web/test/execution-timeline.test.tsx`
- Test: `apps/web/test/context-targets.test.tsx`

**Interfaces:**
- Consumes: workflow local-store API from Task 4 and server API from Task 12.
- Produces:
  - mobile list-first workflow editor;
  - add/remove/move-up/move-down step controls;
  - compatible-tool selection;
  - validate/save/run;
  - execution status/timeline/receipt view;
  - one contextual `text|markdown -> Note` target proof.

- [ ] **Step 1: Write RED editor tests**

Pin keyboard/button operation without drag:

```ts
fireEvent.click(screen.getByRole("button", { name: /move step up/i }));
expect(screen.getAllByTestId("workflow-step")[0]).toHaveTextContent("JSON Select");
```

Test incompatible tools absent from next-step choices.

- [ ] **Step 2: Write RED Run gating test**

A workflow with local pending operation or conflict must show:

```text
Run unavailable until this workflow is synced
```

and the Run button disabled.

This is Review Focus #2 at the UI layer.

- [ ] **Step 3: Implement editor**

Editor authors a linear chain while writing a DAG-compatible `nodes + edges` definition.

No graph visualization dependency.

- [ ] **Step 4: Implement execution timeline**

Poll execution endpoint conservatively while running; stop polling on terminal state. Render step status, attempts, sanitized errors, artifact/output references, and receipt link.

- [ ] **Step 5: Implement compatibility proof**

Use server/tool compatibility result or shared registry data to show Note as compatible for text/markdown selection. Do not hard-code a screen-specific list.

- [ ] **Step 6: Verify Task 13**

```bash
npm run test -w @uw/web
npm run typecheck -w @uw/web
npm run build -w @uw/web
node scripts/verify-pwa.mjs
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat: add linear workflow editor and run history"
```

---

### Task 14: Golden Workflows, Browser E2E, Worker Process Verification, and Docker Vertical Smoke

**Files:**
- Create: `packages/execution/test/golden-workflows.integration.test.ts`
- Create: `apps/web/e2e/workflow-golden.spec.ts`
- Create: `scripts/start-phase3-e2e-fixture.mjs`
- Create: `scripts/verify-worker-mode.mjs`
- Modify: `scripts/smoke-http.mjs`
- Modify: `scripts/verify-no-secrets.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: completed Phase 3 runtime.
- Produces permanent acceptance gates for all four golden workflows and deployment/runtime modes.

- [ ] **Step 1: Add deterministic HTTP fixture**

The fixture must bind loopback for test-only use, but production safe egress must **not** gain a bypass flag.

Tests inject a dedicated transport/resolver policy fixture into the tool composition, or use a public-address test adapter. Never add `ALLOW_LOCALHOST=true` to product config.

Fixture endpoints:

```text
/json        -> 200 {"title":"Golden","body":"Hello"}
/flaky       -> 500 twice, then 200
/slow        -> waits until aborted
/oversize    -> > 5 MiB
```

- [ ] **Step 2: Write PostgreSQL golden workflow tests**

A. `HTTP -> JSON parse -> JSON select/template -> Note`  
B. `JSON -> select -> Text -> Note`  
C. flaky GET -> retry -> success/structured attempts  
D. slow deterministic runner -> cancel -> cancelled receipt.

Verify receipt/provenance/Artifact IDs, not only final note body.

- [ ] **Step 3: Add worker-mode process test**

`scripts/verify-worker-mode.mjs` must:

1. seed a queued deterministic execution;
2. spawn server with `APP_MODE=worker`;
3. verify the configured HTTP port never opens;
4. wait until queued execution becomes terminal;
5. terminate worker cleanly.

- [ ] **Step 4: Add real-browser E2E**

Chromium flow:

1. create/login owner;
2. create project;
3. create linear workflow locally;
4. wait Synced;
5. run;
6. wait Succeeded;
7. inspect timeline/receipt;
8. confirm note output;
9. open second browser context;
10. confirm workflow + execution output are visible after catch-up.

- [ ] **Step 5: Extend Docker vertical smoke**

Use a deterministic public-reachable fixture container/network design that does not weaken production egress policy. The smoke must prove the real `APP_MODE=all` worker drains the execution queue.

Also scan logs/receipts for secret canary and forbidden Authorization/Cookie/Set-Cookie material.

- [ ] **Step 6: Add CI jobs/scripts**

Root scripts:

```json
{
  "e2e:workflow": "playwright test apps/web/e2e/workflow-golden.spec.ts --project=chromium --workers=1",
  "verify:worker-mode": "node scripts/verify-worker-mode.mjs"
}
```

CI must retain existing browser-sync and Docker gates, and add workflow E2E + worker verification without removing Phase 2 coverage.

- [ ] **Step 7: Verify Task 14**

Run focused golden tests, workflow E2E, worker verification, then Docker smoke.

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/execution/test apps/web/e2e scripts .github/workflows/ci.yml package.json
git commit -m "test: add phase 3 golden workflow gates"
```

---

### Task 15: Phase 3 Final Documentation, Security Review, and Release Gate

**Files:**
- Create: `docs/architecture/phase-3.md`
- Modify: `README.md`
- Modify: `docs/runbooks/local-development.md`
- Modify: `docs/superpowers/specs/2026-09-19-phase-3-tool-workflow-core-design.md` only if implementation evidence requires clarification
- No product feature expansion.

**Interfaces:**
- Consumes: the completed Phase 3 branch.
- Produces: final evidence, documented runtime modes, HTTP egress policy, execution troubleshooting, and PR-ready branch.

- [ ] **Step 1: Document actual Phase 3 architecture**

Document:

- packages/boundaries;
- Context Envelope;
- Tool Registry;
- queue/lease behavior;
- runtime modes;
- retry taxonomy;
- budgets/cancellation;
- HTTP egress policy;
- receipts/provenance;
- workflow local-first vs server execution boundary;
- diagnostics and troubleshooting.

- [ ] **Step 2: Update README scope**

Mark Phase 3 current boundary and Phase 4 next boundary. Do not claim AI or universal Send to is implemented.

- [ ] **Step 3: Run permanent security scans/tests**

```bash
npm audit --omit=dev --audit-level=high
npm run test -w @uw/tools
npm run test -w @uw/execution
```

Verify safe-egress and redaction suites explicitly in CI logs.

- [ ] **Step 4: Run full clean quality gate**

```bash
npm ci
npm audit --omit=dev --audit-level=high
npm run verify:workspaces
npm run format:check
npm run lint
npm run typecheck
TEST_DATABASE_URL=postgresql://workbench:workbench@127.0.0.1:5432/workbench_test npm test
npm run build
node scripts/verify-pwa.mjs
npm run e2e:sync
npm run e2e:workflow
npm run verify:worker-mode
```

Then run canonical Docker smoke and secret scan.

Expected: every gate PASS on the same commit.

- [ ] **Step 5: Review branch diff against Phase 3 spec**

Explicitly verify no implementation of:

- AI provider/AI Tool;
- secret vault;
- MCP/plugins;
- graph editor;
- arbitrary code;
- LAN bypass;
- Redis;
- loops/scheduling.

Remove accidental scope creep before PR.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md docs
git commit -m "docs: document phase 3 tool workflow core"
```

- [ ] **Step 7: Open Phase 3 PR**

Title:

```text
Phase 3: Tool & Workflow Core
```

PR body must include:

- final head SHA;
- clean CI run ID;
- golden workflow evidence;
- safe-egress evidence;
- worker-mode evidence;
- Docker smoke evidence;
- scope boundary for Phase 4.

Do not merge until PR-triggered CI is green.

---

## Self-Review

### Spec coverage

- Context Envelope / Context Bus: Tasks 1–2.
- Tool Contract / registry / exact version pins: Tasks 1–2.
- Workflow DAG / linear authoring: Tasks 3, 11, 13.
- Revisioned local-first workflow documents: Task 4.
- Durable execution / queue / receipts / provenance: Tasks 5–8, 11.
- Safe public HTTP: Task 9.
- JSON/Text/Note built-ins: Task 10.
- Runtime modes: Task 12.
- Golden workflows / browser / Docker: Task 14.
- Documentation/security/final gate: Task 15.
- Phase 4/5 deferrals preserved: Tasks 15 scope review.

### Placeholder scan

No `TODO`, `TBD`, `FIXME`, “similar to Task N”, or unspecified “add tests” steps are permitted in this plan. Each task names its files, produced interfaces, RED test behavior, implementation boundary, verification commands, and commit boundary.

### Type consistency

- Task 1 defines the shared schemas.
- Task 2 defines `ToolRunner` and exact registry resolution used by Tasks 3, 8–12.
- Task 4 produces canonical workflow revision APIs consumed by Task 11.
- Task 5 repository ports are implemented in Task 6 and queue port in Task 7.
- Task 8 worker/engine consumes Task 2/6/7 interfaces.
- Task 11 binds WorkflowService to ExecutionService/Engine.
- Task 12 exposes those services to HTTP/runtime.
- Task 13 consumes only the Task 4 local APIs and Task 12 HTTP API.
- Task 14 tests the complete assembled interfaces without introducing product-only test bypasses.

### Review Focus coverage

1. Exact tool version drift -> Task 2 registry tests, Task 11 run tests.
2. Unsynced/conflicted workflow execution -> Task 4 canonical guard, Task 13 UI test.
3. Unsafe redirect/DNS rebinding -> Task 9 transport tests.
4. Ambiguous non-idempotent retry -> Task 8 retry tests, Task 9 method tests.
5. Worker lease expiry/reclaim -> Task 7 Postgres tests, Task 10 side-effect idempotency test.

## Execution Handoff

This plan is intentionally sequential because Tasks 4–12 depend on interfaces stabilized by Tasks 1–3 and 5–8. The recommended execution method is **Native** for this repository/session: the plan carries exact interfaces and tests, while keeping one implementer avoids interface drift across 15 tightly coupled tasks. Use a fresh whole-branch review before the Phase 3 PR.
