# Sub-Agent Delegation with Budget Cascading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement isolated sub-agent delegation with strict iteration budget cascading for the ReAct agent loop.

**Architecture:** New `agent/delegation.ts` module runs an isolated child ReAct loop reusing `AgentToolDispatcher` + provider port; `builtin/agent.ts` injects a synthetic `builtin.agent.delegate@1.0.0` executor when `config.subAgents` is non-empty, accumulating child usage and attaching `nestedTrace` to the supervisor observation.

**Tech Stack:** TypeScript ESM, zod contracts (`@uw/contracts`), vitest, `AgentToolDispatcher`, `ToolExecutor` runtime.

**Spec:** User Task 2 Phase 9 prompt (supervisorContext, subAgentSpec, input, options; clamp `Math.min(spec.maxIterations, remainingSupervisorIterations)`; cumulative tokens; nestedTrace in observation).

## Global Constraints

- Do not write to /tmp or redirect output outside workspace.
- Format with prettier (`npx prettier --write packages/tools`).
- `npm test --workspace=@uw/tools` must pass; `npm run typecheck --workspace=@uw/tools` clean.
- Commit `feat(tools): implement sub-agent delegation with budget cascading` and push to `origin phase-9-multi-agent-orchestration`.

## Review Focus

- Delegation tool name collision with real registry tools — expect whitelist isolation, not leak.
- Zero/negative remainingSupervisorIterations — expect child clamped to >=1 or immediate limit response, not infinite loop.
- Unknown subAgentId from supervisor — expect structured error observation, not throw aborting supervisor loop.
- Secret echo in nested trace — expect same scrub as parent trace.
- Deep nesting (sub-agent delegating again) — expect single-level isolation (no recursive delegate injection unless explicitly passed).

---

### Task 1: Create `agent/delegation.ts` core module

**Files:**
- Create: `packages/tools/src/agent/delegation.ts`
- Test: `packages/tools/test/agent-delegation.test.ts`

**Interfaces:**
- Consumes: `AgentProviderPort` from `../builtin/agent.js`, `AgentToolDispatcher` from `./dispatcher.js`, `AiSubAgentSpec, AgentNestedTraceItem, AgentTraceItem, AiUsage` from `@uw/contracts`, `ToolExecutor, ToolRunContext` + `ContextEnvelope` types.
- Produces:
  - `DELEGATION_TOOL_NAME = "builtin.agent.delegate@1.0.0"`
  - `createDelegationToolDescriptor(): ToolDescriptor`
  - `runSubAgentDelegation(supervisorContext: DelegationSupervisorContext, subAgentSpec: AiSubAgentSpec, input: DelegationInput, options: DelegationOptions): Promise<SubAgentDelegationResult>`
  - `SubAgentDelegationResult { text, status, iterations, trace, usage, usageSource, model, nestedTrace }`

- [ ] **Step 1: Write failing test for delegation module import**

```typescript
import { DELEGATION_TOOL_NAME, runSubAgentDelegation } from "../src/agent/delegation.js";
expect(DELEGATION_TOOL_NAME).toBe("builtin.agent.delegate@1.0.0");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@uw/tools -- agent-delegation` (vitest run)
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `delegation.ts` in `packages/tools/src/agent/delegation.ts`**

Types:
```typescript
interface DelegationSupervisorContext { provider: AgentProviderPort; secretValue: string; tools: ToolExecutor[]; input: ContextEnvelope; context: ToolRunContext; model: string; systemPrompt?: string; maxOutputTokens: number; timeoutMs: number; }
interface DelegationInput { task: string; context?: unknown; idempotencyKey?: string; signal?: AbortSignal; }
interface DelegationOptions { remainingSupervisorIterations: number; providerRequestId?: string; }
```

Logic: `effectiveMax = Math.max(1, Math.min(spec.maxIterations ?? 5, remainingSupervisorIterations))` — child ReAct loop mirrors `builtin/agent.ts`: build dispatcher with `allowedTools: spec.allowedTools`, conversation = `${spec.instructions}\n\n${task}`, iterate provider.complete → dispatchMany → trace push → accumulate usage. Return nestedTrace `{ subAgentId: spec.id, role: spec.role, trace, status, usage }`.

Include `createDelegationToolDescriptor()` returning ToolDescriptor parse `{ id: "builtin.agent.delegate", version: "1.0.0", ... accepts ["text","json"], produces ["agent_response"], executionMode "server", idempotency "keyed", configSchema { type object required [subAgentId, task] } }` and `toDelegationFunctionSpec()` helper mapping to provider tool definition.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace=@uw/tools -- agent-delegation`
Expected: PASS (import resolves; loop tested fully in Task 3).

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/agent/delegation.ts
git commit -m "feat(tools): add sub-agent delegation loop with budget cascading" || true
```
(defer final squash — single commit at end per Global Constraints; this step may be folded.)

### Task 2: Wire delegation tool into supervisor `builtin/agent.ts`

**Files:**
- Modify: `packages/tools/src/builtin/agent.ts`
- Consumes: Task 1 `runSubAgentDelegation`, `DELEGATION_TOOL_NAME`, `createDelegationToolDescriptor`.
- Produces: Supervisor loop with delegation interception, cumulative usage, nestedTrace observation.

- [ ] **Step 1: Write failing test — supervisor injects delegate tool when subAgents present**

```typescript
const result = await runTool(tool, textInput("hi"), { ...baseConfig, allowedTools: [], subAgents: [{ id: "researcher", role: "researcher", instructions: "Be concise", allowedTools: [TRIM_NAME], maxIterations: 2 }] }, baseContext());
expect(provider.complete).toHaveBeenCalled(); // supervisor first call requests delegate
```

Provider sequence: supervisor call_1 → `builtin.agent.delegate@1.0.0` with `{ subAgentId: "researcher", task: "look up X" }`, then final answer. Assert trace[0].observation.nestedTrace.subAgentId === "researcher".

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@uw/tools -- agent-delegation`
Expected: FAIL — supervisor treats delegate as UNAUTHORIZED_TOOL.

- [ ] **Step 3: Implement injection in `packages/tools/src/builtin/agent.ts`**

Approach: after parsing `toolConfig`, if `toolConfig.subAgents.length > 0`: build `delegateExecutor: ToolExecutor` whose `run(input, config, context)` validates `{ subAgentId, task }` via `AgentDelegationInputSchema`, looks up spec, computes `remaining = maxIterations - iteration` (current 1-based iteration remaining incl. current? use `maxIterations - (iteration-1)` clamped), calls `runSubAgentDelegation(...)`, adds child usage to parent accumulators (`promptTokens += child.usage.promptTokens` etc.), returns observation output `{ delegated: { subAgentId, text, status, iterations }, nestedTrace }` — supervisor trace-recording code then attaches `nestedTrace` from a WeakMap/side-channel or by detecting `output.nestedTrace`. Simplest: delegate executor returns `{ __nestedTrace, result }` wrapper; dispatcher loop unwraps: if output has `nestedTrace` key, attach to `trace[].observation.nestedTrace` and keep output serializable. Ensure toolDefs includes delegate spec + dispatcher includes delegate executor + `allowedTools` extended with delegate name (do not mutate user config).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace=@uw/tools -- agent-delegation`
Expected: PASS.

- [ ] **Step 5: Commit**

Fold into final commit (see Task 4).

### Task 3: Export + full test suite `agent-delegation.test.ts`

**Files:**
- Modify: `packages/tools/src/index.ts`
- Test: `packages/tools/test/agent-delegation.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: Public exports `runSubAgentDelegation, createDelegationToolDescriptor, DELEGATION_TOOL_NAME` + 5 passing tests.

- [ ] **Step 1: Write the 5 failing tests**

```typescript
it("delegates sub-task to specialist and returns result to supervisor")
it("sub-agent executes its own scoped tool")
it("nested trace captured in supervisor observation")
it("strict budget cascading caps sub-agent iterations")
it("cumulative token usage across parent and child")
```

Each uses `providerDouble` sequence for supervisor + shared provider double counting calls; child scoped tool = `createTextTrimTool()`. Budget test: supervisor maxIterations 3, spec maxIterations 5, remaining 1 → child effective max 1 (assert child provider calls <=1 and `nestedTrace.trace.length <= 1`). Usage test asserts parent usage === supervisor calls + child calls summed.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@uw/tools -- agent-delegation`
Expected: FAIL (exports missing / behavior wrong).

- [ ] **Step 3: Implement exports in `packages/tools/src/index.ts`**

```typescript
export { DELEGATION_TOOL_NAME, createDelegationToolDescriptor, runSubAgentDelegation } from "./agent/delegation.js";
export type { DelegationInput, DelegationOptions, DelegationSupervisorContext, SubAgentDelegationResult } from "./agent/delegation.js";
```

Plus any Task 2 fixes needed for tests.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@uw/tools`
Expected: PASS all suites.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck --workspace=@uw/tools`
Expected: clean.

### Task 4: Format, verify, commit & push

**Files:** all changed.

- [ ] **Step 1: Format**

Run: `npx prettier --write packages/tools`
Expected: changed files reformatted.

- [ ] **Step 2: Full verify**

Run: `npm test --workspace=@uw/tools`
Run: `npm run typecheck --workspace=@uw/tools`
Expected: both clean.

- [ ] **Step 3: Commit & push**

```bash
git add docs/superpowers/plans/2026-10-11-sub-agent-delegation.md packages/tools/src/agent/delegation.ts packages/tools/src/builtin/agent.ts packages/tools/src/index.ts packages/tools/test/agent-delegation.test.ts
git commit -m "feat(tools): implement sub-agent delegation with budget cascading"
git push origin phase-9-multi-agent-orchestration
```
Expected: push succeeds.
