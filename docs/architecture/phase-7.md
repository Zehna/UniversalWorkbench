# Phase 7 Architecture — HITL Guardrail, Streaming Agent & Parallel Dispatch

> Implementation reference for the `phase-7-hitl-streaming-agent` branch.
> Phase 7 adds human-in-the-loop (HITL) approval for gated agent tools on top
> of the Phase 6 ReAct loop, plus real-time SSE trace streaming and multi-tool
> parallel dispatch. The release boundary is not closed until the Task 6 full
> gate — golden HITL integration, monorepo tests, and typechecks — passes on
> one final commit.

## 1. Scope and package boundaries

Phase 7 keeps Phase 2 local-first sync, Phase 3 DAG/workflow core, Phase 4 AI
provider seam + token budgets, Phase 5 hardening, and Phase 6 ReAct loop
unchanged in behavior, and adds approval/streaming behavior in existing
packages (no new top-level package):

| Package         | Responsibility                                                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@uw/contracts` | `requiresApproval` on `ToolDescriptorSchema` (default `false`); `awaiting_approval` on `ExecutionStatusSchema` + `AgentStatusSchema`; `AgentApprovalRequest/Decision/Resolution` schemas.                                           |
| `@uw/tools`     | `AgentToolDispatcher.dispatch` approval gate + `dispatchMany` parallel fan-out (`Promise.allSettled`); `createAgentTool` suspend (`awaiting_approval` + `structured.pendingApprovals`) and resume via `approvalResolutions` config. |
| `@uw/execution` | Engine suspend/resume state machine (`suspend` → `awaiting_approval` → `resume` → `process`), `resolveApproval` validation, rejection feedback into agent conversation, redacted step persistence.                                  |
| `apps/server`   | `POST /executions/:id/approve`, `POST /executions/:id/reject`, `GET /executions/:id/events` (SSE trace stream); pinned registry with gated tools; owner-scoped approval.                                                            |
| `apps/web`      | `ApprovalCard` (approve/reject + reason), `AgentTraceViewer` live SSE timeline (thought/tool-call/observation + `approval_needed` embed), SSE connection lifecycle.                                                                 |

Dependency direction stays acyclic:

```text
contracts <- tools <- execution <- server <- web (composition only)
providers + tools <- server (structural AgentProviderPort, no cross-import)
```

`@uw/tools` never imports `@uw/providers` or `@uw/execution`. The server
composes engine + dispatcher + providers; the web client only speaks HTTP/SSE.

## 2. HITL guardrail architecture and state machine

Gated tools opt in via `requiresApproval: true` in their descriptor
(`packages/contracts/src/tool.ts`, `ToolDescriptorSchema`). The agent
whitelist (`allowedTools`) is orthogonal: a tool must be both allowed _and_
approved to run.

```text
Provider toolCall -> dispatcher.dispatch(call, input, ctx, approval?)
  |- not whitelisted        -> UNAUTHORIZED_TOOL error observation (loop continues)
  |- unknown but allowed    -> UNKNOWN_TOOL error observation (loop continues)
  |- requiresApproval:
  |    |- approval.approved -> runTool executor (normal path)
  |    |- approval.rejected -> "Action was rejected by user: <reason>" error observation
  |    |- no approval       -> { requiresApproval: true, pendingApproval } (no execution)
  |- else                   -> runTool executor (normal path)
```

`createAgentTool` (`packages/tools/src/builtin/agent.ts`) collects every
`requiresApproval` observation per iteration. If any exist it stops the ReAct
loop immediately with:

```ts
{ status: "awaiting_approval", structured: { pendingApprovals: [...] } }
```

each entry `{ tool, toolCallId?, arguments, reason }`. The payload validates
against `AgentResponsePayloadSchema` before persistence (`INVALID_OUTPUT`
otherwise).

The execution engine (`packages/execution/src/engine.ts`,
`createWorkflowEngine`) owns the durable state machine:

```text
running --(agent emits awaiting_approval)--> suspend() --> awaiting_approval (persisted step + usage)
awaiting_approval --(POST approve {decision: approved})--> resume() --> process() (approvalResolutions injected as node.config)
awaiting_approval --(POST reject {reason})--> resume() --> process() (rejection string fed as error observation)
awaiting_approval --(process() with no resolution)--> suspend() (idempotent re-suspend, no progress)
```

Details:

- `isAwaitingApprovalOutput` detects `agent_response.status ===
"awaiting_approval"`; the step is finished as `awaiting_approval` (not
  `completed`), usage/tokens accumulate, then `store.suspend` persists
  `awaiting_approval` on the execution.
- `resolveApproval(executionId, { decision, rejectionReason? })` validates:
  execution must be `awaiting_approval` (`INVALID_STATE` otherwise), decision
  must be `approved|rejected` (`INVALID_INPUT`), rejection requires a
  non-empty trimmed reason (`INVALID_INPUT`), and at least one
  `pendingApprovals` entry must exist (`INVALID_STATE`). It builds a resolution
  map keyed by both `toolCallId` and `tool` name, stores it in the in-memory
  `pendingResolutions` map, calls `store.resume()` (`awaiting_approval` →
  `running`), then re-enters `process()`.
- On re-entry the engine injects `approvalResolutions` into the agent node
  config. `toApprovalMap` in the agent tool parses it back into per-call
  resolutions. Approved calls execute; rejected calls become
  `"Action was rejected by user: <reason>"` error observations appended to
  the conversation (`Assistant: <thought>\nObservation[i]: <json>`), so the
  next provider turn reasons over the denial and completes alternatively
  without ever invoking the gated executor. The golden suite asserts
  `gatedRun` is called exactly once on approve and zero times on reject, and
  that the resumed view serializes the rejection string + reason.
- Retry interplay: an `awaiting_approval` step reuses its attempt number on
  resume (`max(baseMax, awaitingStep.attempt + 1)` window); a `running` step
  with an unsafe descriptor fails as `UNCERTAIN_OUTCOME` rather than
  double-executing a non-idempotent tool.

Server routes (`apps/server/src/routes/executions.ts`):

- `POST /:executionId/approve` rejects non-empty bodies (400), non-awaiting
  executions (409 `EXECUTION_NOT_AWAITING_APPROVAL`), and missing engine
  wiring (500). Delegates to `engine.resolveApproval(id, { decision:
"approved" })`.
- `POST /:executionId/reject` accepts `{ reason?: string(1..2000) }` strict
  (`RejectBodySchema`), defaults to `"Rejected by user"`, same 409/500
  handling, delegates with `{ decision: "rejected", rejectionReason }`.
- Both are owner-scoped (`requireOwner` + repository `get(ownerId,
projectId, executionId)` → 404 concealment, same rule as Phase 5 IDOR
  handling).

## 3. Secret safety

Secrets never widen authority and never persist:

- `resolveSecret(ref, ownerId)` runs per agent invocation; `secret://local/*`
  fails closed on the server; `secret://vault/*` decrypts via the server
  vault (AES-256-GCM, Phase 4).
- Before the agent result is created, `scrubSecret` + `scrubTraceValue`
  deep-replace the resolved plaintext across final text, thoughts, tool-call
  arguments, observation outputs, and the error-throw path with
  `[REDACTED]`. The engine additionally stores
  `redactSecrets(inputContext)` step snapshots.
- Golden HITL tests use a `HITL_CANARY` vault value and substring-scan the
  full resumed view + receipt for absence, mirroring the Phase 6
  `AGENT_CANARY` guarantee. No test sends real network traffic
  (deterministic injected providers/transports) or weakens egress policy.

## 4. Real-time SSE trace streaming model and client connection lifecycle

`GET /projects/:projectId/executions/:executionId/events`
(`apps/server/src/routes/executions.ts`) streams `text/event-stream`:

1. `buildExecutionEvents(view)` replays history as discrete events:
   `execution` (id/status/project) → per step `step` (id/node/tool/status/
   attempt) → per `agent_response` output per trace item (`thought` /
   `tool_call` / `observation`, defaulting `type: "thought"`) → conditional
   `approval_needed` (when `status === "awaiting_approval"` with
   `pendingApprovals`) → `agent_response` summary (step/output/status/text)
   → terminal `completed`.
2. Headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`,
   `Connection: keep-alive`, `X-Accel-Buffering: no`) flush each `data:
<json>\n\n` frame immediately.
3. If the execution is terminal, the stream ends after replay. Otherwise the
   handler polls the repository every 50 ms for up to 2 s, emitting a
   lightweight `{ type: "status", executionId, status, steps }` frame whenever
   status or step count changes, plus a final replay tail on terminal
   transition, then ends. Client disconnect (`req.destroyed/closed`,
   `res.writableEnded/destroyed`) breaks the loop; header-sent errors end the
   stream instead of calling `next()`.

Client (`apps/web/src/executions/AgentTraceViewer.tsx`):

```text
mount (projectId+executionId) -> new EventSource(/api/.../events)
  -> onmessage: thought -> append thought row
  -> onmessage: tool_call -> append tool-call row
  -> onmessage: observation -> attach to matching iteration
  -> onmessage: approval_needed -> embed <ApprovalCard pendingApprovals>
  -> onmessage: completed/terminal status -> EventSource.close()
unmount -> EventSource.close() (no leak; covered by "closes SSE cleanly" test)
```

`ApprovalCard` posts to `approve` (empty JSON body) or `reject`
(`{ reason }`), surfaces per-action busy/error states, and calls
`onResolved` so the viewer can refresh or close the stream. Pending entries
tolerate both `{ tool, toolCallId, arguments, reason }` and legacy
`{ name, id, args }` shapes.

## 5. Multi-tool parallel execution dispatch with Promise.allSettled

`AgentToolDispatcher.dispatchMany(calls, input, ctx, approvals?)`
(`packages/tools/src/agent/dispatcher.ts`) fans out every provider-requested
tool call in one iteration concurrently:

```ts
const tasks = calls.map((call) =>
  this.dispatch(call, input, ctx, approvalFor(call)),
);
const settled = await Promise.allSettled(tasks);
return settled.map((result, i) =>
  result.status === "fulfilled"
    ? result.value
    : {
        toolCallId: calls[i]?.id,
        output: { error: { code: "TOOL_EXECUTION_FAILED", message, tool } },
        durationMs: 0,
        isError: true,
      },
);
```

- Approval lookup is per call: `approvals[call.id] ?? approvals[call.name]`,
  so a single user decision fans out to both the stable tool name and the
  ephemeral provider `toolCallId`.
- `Promise.allSettled` (not `Promise.all`) guarantees one tool's throw
  becomes a per-call `TOOL_EXECUTION_FAILED` error observation instead of
  failing the whole iteration. The agent records each observation against its
  own `toolCall` in trace order (`iteration`, `thought` only on index 0),
  serializes all observations as `Observation[i]` conversation context, and
  only suspends if _any_ observation requires approval.
- `durationMs` is measured per dispatch (`Date.now()` delta, `>= 0`);
  rejected promises report `0` with `isError: true`.
- Covered by `packages/tools/test/agent-dispatcher-hitl.test.ts` (parallel
  approved/rejected/pending matrix) and the golden HITL suite end-to-end.

## 6. Release gate (Task 6)

```sh
npm run test -w @uw/execution              # engine + golden HITL/agent/AI/workflow suites
npm run test -w @uw/tools                  # agent executor + dispatcher HITL suites
npm run test -w @uw/server                 # HITL approve/reject + SSE streaming suites
npm run test -w @uw/web                    # ApprovalCard + AgentTraceViewer SSE suites
npm run typecheck --workspace=@uw/web      # zero TypeScript errors (requiresApproval on mocks)
npm test                                   # all workspace suites
npm run typecheck                          # zero TypeScript errors repo-wide
```

`packages/execution/test/golden-hitl.integration.test.ts` is the Phase 7
golden gate: approval flow (agent → `awaiting_approval` suspend → approve →
gated tool runs → `completed` with receipt + no secret leak) and rejection
flow (agent → suspend → reject with reason → rejection observation fed into
agent → `completed` without running the gated tool, serialized rejection
visible). DB-backed suites need `TEST_DATABASE_URL`; no test sends real
network traffic or weakens the production egress policy.

## 7. Non-goals carried forward

MCP/plugin expansion, broader ingestion, arbitrary shell/code execution as
agent tools, multi-agent orchestration, multi-step approval chains /
delegated approvers, push-notification approver UX, billing/teams/
marketplace, Redis, and Kubernetes remain out of scope per the product
blueprint.
