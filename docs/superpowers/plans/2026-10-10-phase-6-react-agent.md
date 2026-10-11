# Phase 6 Implementation Plan: Autonomous ReAct Agent

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task.

Branch: `phase-6-react-agent`

---

### Task 1: ReAct Agent Contracts & Output Envelopes

- **Target:** `packages/contracts/src/agent.ts`, `packages/contracts/src/index.ts`
- **Output:** `AiAgentConfigSchema`, `AgentTraceItemSchema`, `AgentResponseEnvelope` (`agent_response`).
- **Tests:** `packages/contracts/test/agent-schemas.test.ts`
- **Commit:** `feat(contracts): add react agent config and trace schemas`

---

### Task 2: Provider Tool-Calling Abstraction

- **Target:** `packages/providers/src/types.ts`, `mock.ts`, `http-provider.ts`
- **Output:** Add `tools` parameter support to `ProviderRequest` and `toolCalls` to `ProviderResult`.
- **Tests:** `packages/providers/test/tool-calling.test.ts`
- **Commit:** `feat(providers): add tool-calling support to provider abstraction and mock`

---

### Task 3: Tool Dispatcher & Function Calling Adapter

- **Target:** `packages/tools/src/agent/dispatcher.ts`
- **Output:** Convert `ToolDescriptor` to OpenAI function calling spec; dispatch tool calls against granted permissions.
- **Tests:** `packages/tools/test/agent-dispatcher.test.ts`
- **Commit:** `feat(tools): add function calling adapter and permission-checked tool dispatcher`

---

### Task 4: ReAct Agent Tool Executor (`builtin.ai.agent@1.0.0`)

- **Target:** `packages/tools/src/builtin/agent.ts`, `packages/tools/src/index.ts`
- **Output:** `builtin.ai.agent@1.0.0` implementing the iterative ReAct loop with max-iterations and budget guards.
- **Tests:** `packages/tools/test/agent-tool.test.ts`
- **Commit:** `feat(tools): implement builtin.ai.agent react executor`

---

### Task 5: Server Wiring & Diagnostic Trace Persistence

- **Target:** `apps/server/src/composition.ts`, `apps/server/src/routes/artifacts.ts`
- **Output:** Register agent tool in server, persist redacted trace in execution records, support Send-to Document.
- **Tests:** `apps/server/test/agent-workflow.integration.test.ts`
- **Commit:** `feat(server): wire agent tool and persist sanitized reasoning traces`

---

### Task 6: Web UI — ReAct Trace Viewer & Agent Step Editor

- **Target:** `apps/web/src/workflows/AgentStepEditor.tsx`, `apps/web/src/executions/AgentTraceViewer.tsx`
- **Output:** Interactive timeline of Thoughts, Tool Calls, and Observations; configuration form for allowed tools.
- **Tests:** `apps/web/test/agent-trace-viewer.test.tsx`
- **Commit:** `feat(web): add react agent trace viewer and step editor`

---

### Task 7: Golden Integration, Hardening, Runbook, & Final Phase 6 Gate

- **Target:** `packages/execution/test/golden-agent.integration.test.ts`, `docs/architecture/phase-6.md`, `README.md`
- **Output:** Golden test (Agent uses HTTP tool -> processes JSON -> creates Note), runbook updates, full gate pass.
- **Commit:** `docs: close phase 6 react agent`
