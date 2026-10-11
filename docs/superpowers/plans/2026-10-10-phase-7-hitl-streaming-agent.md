# Phase 7 Implementation Plan: Human-in-the-Loop & Real-Time Streaming Agent

Branch: `phase-7-hitl-streaming-agent`

---

### Task 1: HITL Contracts & Approval Envelopes

- **Target:** `packages/contracts/src/agent.ts`, `packages/contracts/src/execution.ts`
- **Output:** Add `requiresApproval` to tool descriptor schema, add `awaiting_approval` status, and define `AgentApprovalRequestSchema`.
- **Tests:** `packages/contracts/test/phase-7-contracts.test.ts`
- **Commit:** `feat(contracts): add hitl approval schemas and execution state`

---

### Task 2: Parallel Tool Dispatcher & Approval Suspension in Engine

- **Target:** `packages/tools/src/agent/dispatcher.ts`, `packages/tools/src/builtin/agent.ts`
- **Output:** Multi-tool parallel execution using `Promise.allSettled`, detection of `requiresApproval`, and suspended state handoff.
- **Tests:** `packages/tools/test/agent-dispatcher-hitl.test.ts`
- **Commit:** `feat(tools): add parallel tool dispatch and approval suspension`

---

### Task 3: Execution Engine Resume/Reject Mechanics

- **Target:** `packages/execution/src/engine.ts`, `packages/execution/src/types.ts`
- **Output:** Durable queue support for resuming suspended executions on user decision, passing rejection observation into agent context.
- **Tests:** `packages/execution/test/hitl-engine.test.ts`
- **Commit:** `feat(execution): support suspend and resume with rejection feedback`

---

### Task 4: Server SSE Endpoint & Approval APIs

- **Target:** `apps/server/src/routes/executions.ts`, `apps/server/src/app.ts`
- **Output:** `GET /api/executions/:id/events` (SSE streaming) and `POST /api/executions/:id/(approve|reject)`.
- **Tests:** `apps/server/test/hitl-streaming.integration.test.ts`
- **Commit:** `feat(server): add sse trace stream and approval action endpoints`

---

### Task 5: Web UI — Live Streaming & Approval Modal

- **Target:** `apps/web/src/executions/AgentTraceViewer.tsx`, `apps/web/src/executions/ApprovalCard.tsx`
- **Output:** Live SSE consumer, animated thought stream, and interactive Approve/Reject card with parameter preview.
- **Tests:** `apps/web/test/agent-hitl-streaming.test.tsx`
- **Commit:** `feat(web): add live sse stream viewer and hitl approval card`

---

### Task 6: Golden E2E Verification, Architecture Runbook, & Phase 7 Gate Pass

- **Target:** `packages/execution/test/golden-hitl.integration.test.ts`, `docs/architecture/phase-7.md`, `README.md`
- **Output:** End-to-end test (Agent triggers destructive tool -> pauses -> approved -> continues -> completes), runbook documentation.
- **Commit:** `docs: close phase 7 hitl streaming agent`
