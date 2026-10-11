# Phase 9 Architecture — Multi-Agent Orchestration & Sub-Agent Delegation

> Implementation reference for the `phase-9-multi-agent-orchestration` branch.
> Phase 9 adds hierarchical multi-agent collaboration on top of the Phase 6
> ReAct loop: a supervisor agent delegates bounded sub-tasks to specialist
> sub-agents through `builtin.agent.delegate@1.0.0`, each child runs an
> isolated ReAct loop with a scoped toolset and cascaded budgets, and Phase 7
> HITL guardrails bubble up with full lineage. The release boundary is not
> closed until the Task 6 full gate — golden multi-agent integration,
> monorepo tests, and typechecks — passes on one final commit.

## 1. Scope and package boundaries

Phase 9 keeps Phase 2 local-first sync, Phase 3 DAG/workflow core, Phase 4 AI
provider seam + token budgets, Phase 5 hardening, Phase 6 ReAct loop,
Phase 7 HITL/streaming/parallel dispatch, and Phase 8 MCP bridging unchanged
in behavior, and adds delegation/orchestration behavior in existing packages
(no new top-level package):

| Package         | Responsibility                                                                                                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@uw/contracts` | `AiSubAgentSpecSchema` (`id`/`role`/`instructions`/`allowedTools`/`maxIterations`/`maxOutputTokens`), `AgentDelegationInputSchema` (`subAgentId`/`task`/`context?`), `AgentNestedTraceItemSchema`, `AgentTraceItemSchema.nestedTrace?`, `AiAgentConfigSchema.subAgents`.     |
| `@uw/tools`     | `DELEGATION_TOOL_NAME` (`builtin.agent.delegate@1.0.0`), `runSubAgentDelegation` child ReAct loop + budget cascade, `createDelegationToolDescriptor` / `toDelegationFunctionSpec`, supervisor delegation branch in `createAgentTool`, child-scoped `AgentToolDispatcher`.    |
| `@uw/execution` | No engine state-machine changes; suspend/resume carries nested approvals unchanged. Golden suite proves delegation + nested HITL end-to-end (`packages/execution/test/golden-multi-agent.integration.test.ts`).                                                              |
| `apps/server`   | Pinned registry wiring via `composeAgentTool`/`composeToolRegistry`, nested-trace persistence (agent_response outputs), SSE `sub_agent_turn` lineage frames in `buildExecutionEvents`, approve/reject resume of nested approvals, Send-to Document over multi-agent outputs. |
| `apps/web`      | `AgentTraceViewer` collapsible sub-agent timeline blocks, `AgentStepEditor` Sub-Agent Squad tab (id/role/instructions/tools/iterations), `agent-squad-viewer` coverage.                                                                                                      |

Dependency direction stays acyclic:

```text
contracts <- tools <- execution <- server <- web (composition only)
providers + tools <- server (structural AgentProviderPort, no cross-import)
```

`@uw/tools` never imports `@uw/providers`, `@uw/execution`, or
`@uw/database`. The server composes engine + dispatcher + providers +
registry; the web client only speaks HTTP/SSE.

## 2. Multi-agent orchestration and sub-agent delegation contracts

Contracts (`packages/contracts/src/agent.ts`) model the squad as data:

```ts
AiSubAgentSpecSchema = {
  id: string(1..128),
  role: string(1..128),
  instructions: string(1..100_000),
  allowedTools: string[](default []),
  maxIterations: int 1..15 (default 5),
  maxOutputTokens?: int 1..128_000,
};
AiAgentConfigSchema = { ..., subAgents: AiSubAgentSpec[](default []) };
AgentDelegationInputSchema = { subAgentId: string, task: string, context?: unknown };
AgentNestedTraceItemSchema = { subAgentId, role, trace: AgentTraceItem[], status: AgentStatus, usage: AiUsage };
AgentTraceItemSchema = { iteration, thought?, toolCall?, observation?, nestedTrace? };
```

Runtime (`packages/tools/src/agent/delegation.ts`):

```text
DELEGATION_TOOL_ID = "builtin.agent.delegate" / VERSION "1.0.0"
createDelegationToolDescriptor(): accepts [text, json], permissions [ai],
  capabilities [tool-calling, delegation], idempotency keyed
toDelegationFunctionSpec(): provider function-calling spec for the supervisor turn
```

Supervisor branch (`packages/tools/src/builtin/agent.ts`):

```text
Provider toolCall -> isDelegationCall(name = hasSubAgents && name === DELEGATION_TOOL_NAME)
  |- delegation call:
  |    |- parse { subAgentId, task, context? } (INVALID_DELEGATION_INPUT observation on failure)
  |    |- lookup subAgents by id (UNKNOWN_SUB_AGENT observation on miss)
  |    |- runSubAgentDelegation({ provider, secretValue, tools, input, context, model, ... }, spec, { task, context? }, { remainingSupervisorIterations, approvalResolutions })
  |    |- accumulate child usage into parent totals; attach child.nestedTrace to this iteration's trace item
  |    |- collect child.pendingApprovals into awaiting set (suspend path below)
  |- normal call: dispatcher.dispatchMany over non-delegation calls (Phase 7 path unchanged)
```

The delegation tool is implicit: it is offered as a provider function spec
whenever `subAgents.length > 0` and never needs to appear in `allowedTools`.
The agent itself stays excluded from its own dispatch set, and untrusted
observation content (serialized JSON context) can never widen the grant.

## 3. Budget cascading (iteration caps and token quota inheritance)

`runSubAgentDelegation` enforces strict nesting — a child can never outlive
or outspend its parent:

```text
remaining = maxIterations - iteration + 1   // supervisor iterations left including current
if remaining < 1 -> child status iteration_limit_reached (0 iterations, 0 usage)
effectiveMax = max(1, min(spec.maxIterations, floor(remaining)))
child loop 1..effectiveMax:
  provider.complete({ prompt: "<instructions>\n\n<task>[\n\nContext: <json>]", tools: child-scoped specs, ... })
  dispatch via child-scoped AgentToolDispatcher(tools, allowedTools = spec.allowedTools)
  awaiting approval -> status awaiting_approval + pendingApprovals (with subAgentId/role/toolCall)
  final text (no tool call) -> status completed
  exhaust effectiveMax with tool calls -> status iteration_limit_reached
maxOutputTokens = spec.maxOutputTokens ?? supervisor maxOutputTokens
timeout/abort propagates from supervisor ToolRunContext
```

Token quota inheritance is additive accounting, not a separate limiter:
every child turn's `usage.{prompt,completion,total}Tokens` is added into the
supervisor's running totals (`promptTokens += child.usage...`), and
`usageSource` degrades to `estimated` if any child turn is non-provider.
The golden suite asserts the exact cascade
(supervisor 30 + child 10 + 10 + supervisor 52 = 102 total; child
`nestedTrace.usage` 12/8/20) and that `execution.usage` matches the agent
payload with `total = prompt + completion`.

Covered by `packages/tools/test/agent-delegation.test.ts` (late-delegation
cap: supervisor `maxIterations: 2` forces the child to 1 iteration with
`iteration_limit_reached`) and the Phase 9 golden E2E.

## 4. Nested HITL approval propagation with lineage

The Phase 7 gate is reused unchanged inside the child loop; only the
lineage wrapper is new:

```text
Child provider toolCall (gated, allowed in spec.allowedTools)
  -> child dispatcher.dispatchMany(..., approvalResolutions)
  -> observation { requiresApproval: true, pendingApproval: { tool, toolCallId?, arguments, reason } }
  -> child maps to SubAgentPendingApproval { ..., subAgentId, role, toolCall: { id?, name, arguments } }
  -> child returns status awaiting_approval + pendingApprovals
  -> supervisor attaches nestedTrace + suspends with:
     { status: awaiting_approval, structured: { pendingApprovals: [{ tool, toolCallId?, arguments, reason, subAgentId, role, toolCall }] } }
Engine (unchanged): running -> suspend -> awaiting_approval (persisted step + usage)
resolveApproval({ approved }) -> resume -> process() with approvalResolutions injected
  -> child re-runs the gated executor once, completes, supervisor aggregates and completes
resolveApproval({ rejected, reason }) -> rejection string "Action was rejected by user: <reason>"
  fed as error observation into the child conversation; gated executor never runs
```

Lineage guarantees:

- Every pending entry carries `subAgentId`, `role`, and the originating
  `toolCall { name, arguments }` so the UI and API can attribute the
  approval to the correct specialist.
- `packages/execution/test/nested-hitl.test.ts` asserts suspension,
  lineage shape, approve-resume (gated runs once, nested trace
  `completed`, final contains the gated output), and reject-feedback.
- The Phase 9 golden nested-HITL test repeats the full engine path
  (`awaiting_approval` with `pendingApprovals[0].tool === gatedName` +
  `subAgentId === researcher`, `gatedRun` 0 before / 1 after approve,
  nested trace `completed` with the gated call inside, receipt
  `completed`, no canary leak).
- Secret scrubbing covers the nested path: `scrubSecret`/`scrubTraceValue`
  run over child thoughts, tool-call args, and observations before
  persistence; the server suite asserts a leaked vault plaintext in child
  output persists only as `[REDACTED]`.

## 5. UI hierarchy in AgentTraceViewer and AgentStepEditor

`AgentTraceViewer` (`apps/web/src/executions/AgentTraceViewer.tsx`):

```text
trace[] (supervisor iterations)
  |- Iteration N: Thought / Tool Call / Observation (existing rows)
  |- nestedTrace? -> <section aria-label="Sub-agent <id>">
       Sub-agent <id> (<role>) / Status / Usage (formatTokenUsage)
       [Show/Hide sub-agent] (per-iteration subExpanded set)
         -> <ol aria-label="Sub-agent <id> timeline">
              Sub-agent iteration M: Thought / Tool call (+ args) / Observation preview
live SSE: sub_agent_turn frames (subAgentId/role/status/usage) + nested thought/tool/observation
  frames append under the same lineage; approval_needed embeds <ApprovalCard>
  with subAgentId/role-aware pending entries
```

`AgentStepEditor` (`apps/web/src/workflows/AgentStepEditor.tsx`):

```text
Agent step editor (provider/model/prompt/system/secretRef/maxIterations/allowedTools + MCP section)
  -> <fieldset aria-label="Sub-Agent Squad">
       Sub-agent 1..N: id (unique, <=128) / role / instructions / max iterations (1-15, clamped)
         + allowed-tools checklist (full catalog incl. mcp.*)
         + inline validation (id required+unique, role/instructions required, iterations 1-15)
       [Add sub-agent] / [Remove sub-agent N]
```

Covered by `apps/web/test/agent-squad-viewer.test.tsx` (nested timeline
expand/collapse, squad add/remove/validation). SSE lineage frames come from
`buildExecutionEvents` (`apps/server/src/routes/executions.ts`): each
`nestedTrace` emits one `sub_agent_turn` event plus per-child-item events
carrying `subAgentId`/`role`, so live runs render the hierarchy before the
step completes.

## 6. Release gate (Task 6)

```sh
npm run test -w @uw/execution              # engine + golden multi-agent/nested-HITL/MCP/HITL/agent suites
npm run test -w @uw/tools                  # delegation/budget + dispatcher HITL suites
npm run test -w @uw/contracts              # sub-agent delegation + nested trace schema suites
npm run test -w @uw/server                 # multi-agent workflow/SSE/approval suites
npm run test -w @uw/web                    # squad viewer + trace viewer suites
npm test                                   # all workspace suites
npm run typecheck                          # zero TypeScript errors repo-wide
npx prettier --write .                     # CircleCI quality gate
```

`packages/execution/test/golden-multi-agent.integration.test.ts` is the
Phase 9 golden gate: (1) supervisor delegates to a specialist that runs a
scoped tool (`builtin.text.trim`) and returns — `completed` with verified
nested traces (`subAgentId`/`role`/`completed`/child tool + observation)
and cascaded token usage (payload + `execution.usage`, receipt, no secret
leak); (2) nested HITL (`awaiting_approval` suspend with sub-agent lineage
→ approve → gated tool runs once → supervisor finishes `completed` with
nested trace, receipt, and no secret leak). DB-backed suites need
`TEST_DATABASE_URL`; no test sends real network traffic (deterministic
injected providers/transports) or weakens the production egress policy.

## 7. Non-goals carried forward

Live SSE `tools/list` + `tools/call` streaming transport, MCP OAuth /
per-tool auth, multi-server federation beyond `mcp.<server>.<tool>`,
cross-supervisor (peer-to-peer) negotiation, multi-step approval chains /
delegated approvers, billing/teams/marketplace, Redis, and Kubernetes remain
out of scope per the product blueprint.
