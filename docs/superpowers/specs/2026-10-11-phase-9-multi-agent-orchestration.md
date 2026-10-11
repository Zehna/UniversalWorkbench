# Phase 9 Design Spec: Multi-Agent Orchestration & Sub-Agent Delegation

## 1. Goal & Architectural Boundary

Phase 9 enables hierarchical multi-agent collaboration within UniversalWorkbench:

- A primary supervisor agent can dynamically delegate bounded sub-tasks to specialized sub-agents.
- Each sub-agent runs an isolated ReAct loop with a scoped toolset and a cascaded token/iteration budget.
- Security boundaries are preserved: sub-agents inherit whitelist restrictions, secret masking, and Phase 7 HITL approval guardrails bubble up seamlessly to the user.

## 2. Core Pillars

### Pillar 1: Sub-Agent Delegation Contracts

- Sub-agent schema: `AiSubAgentSpecSchema` defining `role`, `instructions`, `allowedTools`, `maxIterations`, and `maxOutputTokens`.
- Built-in delegation tool: `builtin.agent.delegate@1.0.0` allowing the primary agent to invoke sub-agents by role.

### Pillar 2: Nested Traces & Budget Cascading

- Nested reasoning traces: Child agent iterations are captured as nested timeline items (`AgentNestedTraceItem`) within the parent's observation.
- Strict budget cascading: Parent allocates a capped fraction of iterations and token budget to children; child cannot exceed parent's limits.
- HITL bubble-up: If a child agent calls an approval-gated tool, the suspension propagates to the execution root with full lineage context.

### Pillar 3: Hierarchical UI & Squad Configuration

- Web UI timeline: `AgentTraceViewer` renders collapsible sub-agent execution boxes with nested thought/tool/observation timelines.
- Workflow editor: `AgentStepEditor` supports configuring specialist sub-agent squads alongside the primary agent.
