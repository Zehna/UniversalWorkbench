# Phase 9 Implementation Plan: Multi-Agent Orchestration & Sub-Agent Delegation

Branch: `phase-9-multi-agent-orchestration`

---

### Task 1: Multi-Agent Contracts & Delegation Envelopes

- **Target:** `packages/contracts/src/agent.ts`, `packages/contracts/src/index.ts`
- **Output:** `AiSubAgentSpecSchema`, `AgentDelegationInputSchema`, `AgentNestedTraceItemSchema`, and updated `AiAgentConfigSchema`.
- **Tests:** `packages/contracts/test/phase-9-contracts.test.ts`
- **Commit:** `feat(contracts): add sub-agent delegation and nested trace schemas`

---

### Task 2: Sub-Agent Delegation Executor & Budget Cascading

- **Target:** `packages/tools/src/agent/delegation.ts`, `packages/tools/src/builtin/agent.ts`
- **Output:** Builtin delegation runner, budget cascading (maxIterations and token quota inheritance), and nested trace recording.
- **Tests:** `packages/tools/test/agent-delegation.test.ts`
- **Commit:** `feat(tools): implement sub-agent delegation with budget cascading`

---

### Task 3: Nested HITL Approval Propagation

- **Target:** `packages/tools/src/agent/dispatcher.ts`, `packages/execution/src/engine.ts`
- **Output:** Propagating `requiresApproval` suspensions from sub-agent up through the parent agent to the root execution state.
- **Tests:** `packages/execution/test/nested-hitl.test.ts`
- **Commit:** `feat(execution): support nested approval propagation from sub-agents`

---

### Task 4: Server Wiring & Lineage Trace Persistence

- **Target:** `apps/server/src/composition.ts`, `apps/server/src/routes/executions.ts`
- **Output:** Wiring delegation executor into ToolRegistry, persisting nested multi-agent traces, and SSE event streaming for child agent turns.
- **Tests:** `apps/server/test/multi-agent-workflow.integration.test.ts`
- **Commit:** `feat(server): wire delegation tool and stream nested sub-agent traces`

---

### Task 5: Web UI — Hierarchical Trace Viewer & Squad Editor

- **Target:** `apps/web/src/executions/AgentTraceViewer.tsx`, `apps/web/src/workflows/AgentStepEditor.tsx`
- **Output:** Collapsible sub-agent timeline blocks in AgentTraceViewer and squad configuration tab in AgentStepEditor.
- **Tests:** `apps/web/test/agent-squad-viewer.test.tsx`
- **Commit:** `feat(web): add nested sub-agent timeline viewer and squad editor`

---

### Task 6: Golden E2E Verification, Architecture Runbook, & Phase 9 Gate Pass

- **Target:** `packages/execution/test/golden-multi-agent.integration.test.ts`, `docs/architecture/phase-9.md`, `README.md`
- **Output:** End-to-end golden test (Supervisor delegates to Specialist Sub-Agent -> Sub-agent runs MCP tool -> Parent aggregates -> Completed), docs, gate pass.
- **Commit:** `docs: close phase 9 multi-agent orchestration`
