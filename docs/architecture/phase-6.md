# Phase 6 Architecture — Autonomous ReAct Agent

> Implementation reference for the `phase-6-react-agent` branch. Phase 6 adds
> a goal-driven ReAct (Reasoning + Acting) agent loop on top of the Phase 3–5
> tool/workflow core, with strict iteration, permission, and secret guardrails,
> persisted reasoning traces, and UI transparency. The release boundary is not
> closed until the Task 7 full gate — golden agent integration, monorepo tests,
> and typechecks — passes on one final commit.

## 1. Scope and package boundaries

Phase 6 keeps the Phase 2 local-first sync, Phase 3 DAG/workflow core, Phase 4
AI provider seam, and Phase 5 hardening unchanged, and adds agent behavior in
existing packages (no new top-level package):

| Package         | Responsibility                                                                    |
| --------------- | --------------------------------------------------------------------------------- |
| `@uw/contracts` | `AiAgentConfigSchema`, `AgentTraceItemSchema`, `AgentResponsePayloadSchema` (`agent_response`). |
| `@uw/providers` | Tool-calling extension: `tools` on `ProviderRequest`, `toolCalls` on `ProviderResult` (mock + HTTP). |
| `@uw/tools`     | `AgentToolDispatcher` (function-calling adapter + whitelist), `builtin.ai.agent@1.0.0` ReAct executor. |
| `@uw/execution` | Unchanged engine: token aggregation extended to `agent_response`, redacted step persistence. |
| `apps/server`   | Agent registration in the pinned registry, sanitized trace persistence, Send-to Document/Artifact for `agent_response`. |
| `apps/web`      | `AgentStepEditor` (allowed-tools + iteration config), `AgentTraceViewer` (thought/tool-call/observation timeline). |

Dependency direction (acyclic, same rule as Phase 4):

```text
egress <- providers
egress <- tools
providers + tools <- server (composition only; structural port, no cross-import)
```

`@uw/tools` never imports `@uw/providers`. The server composes both through
the structural `AgentProviderPort` interface (`complete({model, prompt,
secretValue, signal, tools})` → `{text, model, usage, toolCalls}`) with a
compile-time assignability assertion.

## 2. ReAct loop engine and early termination (cap 15 iterations)

`packages/tools/src/builtin/agent.ts` (`createAgentTool`) implements the loop:

```text
Prompt + input -> LLM (thought + toolCall?) -> dispatcher -> Observation
  -> append "Assistant: <thought>\nObservation[i]: <json>" -> next thought
  -> Final Output (no toolCall) | iteration_limit_reached
```

- Config (`AiAgentConfigSchema`): `providerId`, `model`, `prompt`, optional
  `systemPrompt`, `secretRef`, `allowedTools` (default `[]`),
  `maxIterations` (default 5, min 1, **max 15** — Zod rejects 16+),
  `maxOutputTokens`. `builtin.ai.agent@1.0.0` accepts `text`/`markdown`/`json`,
  produces `agent_response`, requires the `ai` permission, idempotency `keyed`.
- Per iteration: provider timeout 30s (`AbortSignal.timeout`), caller-abort
  propagation (`ABORTED`), provider errors mapped to `TIMEOUT`/`ABORTED`/
  `NETWORK_FAILURE`. Only the **first** `toolCalls[0]` is dispatched per
  iteration; an empty/missing name ends the loop as `completed`.
- Early termination: a final response with no tool call ends `completed`
  before the budget is spent; reaching `maxIterations` with a pending tool
  call ends `iteration_limit_reached` with the full trace intact. The golden
  suite asserts both paths plus the 15-iteration schema cap.
- Token accounting: per-iteration `promptTokens`/`completionTokens`/
  `totalTokens` accumulate; `usageSource` is `provider` only if every
  iteration reported provider metering, else `estimated`. The execution engine
  (`aiTokensOf`) sums `agent_response` exactly like `ai_response`, recomputed
  from persisted steps so interrupted attempts add zero and lease reclaims
  never double-count. `BUDGET_EXCEEDED`/token guards apply post-step as in
  Phase 4.

## 3. Tool whitelist authorization & prompt injection mitigation

- **Whitelist:** `AgentToolDispatcher` (`packages/tools/src/agent/dispatcher.ts`)
  converts each allowed `ToolDescriptor` to an OpenAI function-calling spec
  (`{name: "<id>@<version>", description, parameters: configSchema}`) via
  `toFunctionCallingSpec`, and exposes only `allowedTools`-listed specs to the
  provider (`listSpecs`, sorted). `dispatch` rejects missing names
  (`UNAUTHORIZED_TOOL`), non-whitelisted names (`UNAUTHORIZED_TOOL` with the
  attempted name), and whitelisted-but-unregistered names (`UNKNOWN_TOOL`) as
  **error observations** — the loop continues to a final answer instead of
  failing the workflow.
- **Permission re-check:** dispatched tools run through `runTool`, which
  enforces the server grant per step (`http` needs `network`, agent needs
  `ai`). AI output text claiming grants never widens the grant — `content
  cannot grant permissions` holds from Phase 4. The agent itself is excluded
  from its own dispatch set to prevent recursive invocation.
- **Prompt injection isolation:** tool observation outputs are serialized as
  `Observation[i]: <JSON>` conversation context, never as trusted
  instructions; untrusted tool content cannot add tools to the whitelist or
  escalate permissions. The golden suite covers this with an injected
  `builtin.shell.exec@1.0.0` request that must surface as an
  `UNAUTHORIZED_TOOL` observation while the agent still completes.

## 4. Trace persistence, secret scrubbing, and UI transparency

- **Trace shape:** every iteration pushes an `AgentTraceItem` (`iteration`,
  `thought`, optional `toolCall {id?, name, arguments}`, optional `observation
  {toolCallId?, output, durationMs, isError}`). The final `agent_response`
  payload carries `{text, model, status, iterations, trace, usage,
  usageSource}` and validates against `AgentResponsePayloadSchema` before
  persistence (`INVALID_OUTPUT` otherwise).
- **Secret scrubbing:** the resolved `secretValue` is scrubbed (deep
  `scrubTraceValue` over final text, thoughts, arguments, observations, plus
  error-message scrub on the throw path) before the result is created, so
  provider echoes of bearer material persist as `[REDACTED]`. Step rows
  additionally store `redactSecrets(inputContext)` snapshots via the engine.
  The golden and server suites substring-scan views for the vault canary.
- **Persistence & Send-to:** the execution engine stores the agent output as a
  normal `agent_response` output context with provenance edges and a receipt
  (`outputContextIds` includes the agent output). Send-to routes accept
  `agent_response` for both Note (`documents/from-execution`, body = payload
  `text`, title `Agent result`, 512 KiB cap) and Artifact (`artifacts/
  from-execution`), generated from Context Bus compatibility plus granted
  permissions — never hard-coded per screen.
- **UI:** `AgentTraceViewer` renders the expandable thought → tool-call
  (name + args preview) → observation (JSON, duration, error flag) timeline
  with model/status/iteration header and `formatTokenUsage` (`~` for
  estimated); `AgentStepEditor` configures `allowedTools` (tool catalog),
  `maxIterations` (1–15), prompt/system prompt, and provider/secret. Large
  payloads reuse the truncated expandable rendering from Phase 5.

## 5. Release gate (Task 7)

```sh
npm test
npm run typecheck
```

`npm test` runs every workspace suite (`--workspaces --if-present`), including
`packages/execution/test/golden-agent.integration.test.ts` (ReAct HTTP →
observe JSON → reason → final response; whitelist negative; iteration-cap
termination; trace + token + Send-to-Document + no-leak assertions),
`packages/tools/test/agent-tool.test.ts`, `agent-dispatcher.test.ts`,
`packages/providers/test/tool-calling.test.ts`,
`packages/contracts/test/agent-schemas.test.ts`,
`apps/server/test/agent-workflow.integration.test.ts`, and
`apps/web/test/agent-trace-viewer.test.tsx`. `npm run typecheck` must report
zero TypeScript errors. DB-backed suites need `TEST_DATABASE_URL`; no test
sends real network traffic (deterministic injected transports) or weakens the
production egress policy.

## 6. Non-goals carried forward

MCP/plugin expansion, broader ingestion, arbitrary loops/shell/code execution
as agent tools, multi-agent orchestration, billing/teams/marketplace, Redis,
and Kubernetes remain out of scope per the product blueprint.
