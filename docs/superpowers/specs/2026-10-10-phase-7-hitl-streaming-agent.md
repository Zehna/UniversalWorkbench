# Phase 7 Design Spec: Human-in-the-Loop Approval & Real-Time Agent Streaming

## 1. Goal & Architectural Boundary

Phase 7 elevates the autonomous ReAct agent into a production-safe, interactive system by introducing:

1. **Human-in-the-Loop (HITL) Guardrails:** Dangerous or mutating actions require explicit human authorization before execution.
2. **Real-time Trace Streaming:** Low-latency event streaming (SSE) to visualize the agent's thought process as it happens.
3. **Parallel Tool Execution:** Bounded concurrency for multi-tool invocations in a single turn.

## 2. Core Pillars

### Pillar 1: Interactive Tool Approval & Workflow Suspension

- Dangerous tool classification: `requiresApproval` flag in `ToolDescriptor` or scoped permissions.
- Workflow suspension: When an approved-only tool is called, the execution transitions to `awaiting_approval`, recording pending tool parameters.
- Resolution routes: `POST /api/executions/:id/approve` and `POST /api/executions/:id/reject`.
- Rejection feedback: If rejected, the agent receives an explicit observation ("User rejected action: <reason>") and reasons for an alternative path.

### Pillar 2: Real-Time Event Streaming (SSE)

- Server endpoint: `GET /api/executions/:id/events` streams iteration updates (`thought`, `tool_call`, `observation`, `approval_needed`, `completed`).
- Web client: `AgentTraceViewer` renders incoming steps incrementally with live loading animations.

### Pillar 3: Multi-Tool Concurrency

- Parallel dispatch: Simultaneous tool calls in one turn are executed concurrently via `Promise.allSettled` while strictly maintaining isolated secret bounds.
