# Phase 6 Design Spec: Autonomous ReAct Agent & Dynamic Tool Calling

## 1. Goal & Architectural Boundary
Phase 6 introduces autonomous goal-driven workflows via a ReAct (Reasoning + Acting) loop agent while preserving the hardened security boundaries established in Phase 5:
- The agent reasons step-by-step, selectively executes registered tools, observes results, and iterates toward a goal.
- Strict guardrails: finite iteration budget (max iterations), token budget monitoring, whitelist-based tool permissions, and zero-secret leaks in reasoning traces.

## 2. Core Pillars
### Pillar 1: ReAct Engine & Loop Control
- Iteration sequence: Prompt -> LLM (Thought + ToolCall) -> Tool Execution -> Observation -> Next Thought -> Final Output.
- Loop termination: Max iterations default 5 (cap 15). Early termination on goal reach or structured `AGENT_ITERATION_LIMIT_REACHED`.

### Pillar 2: Whitelist Permissions & Security
- Strict tool authorization: The agent can ONLY invoke tools listed in its node configuration and permitted in the workflow scope.
- Untrusted content isolation: Tool observation outputs are wrapped to mitigate prompt injection.
- Secret safety: `secret://` parameters are resolved at execution and never recorded in the prompt reasoning trace.

### Pillar 3: Trace Persistence & UI Transparency
- Detailed execution trace: Every thought, tool call parameters, execution time, and observation is captured.
- Expandable timeline UI: Users can inspect every step of the agent's reasoning.
