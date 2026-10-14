# Phase 10 Design Spec: Sandboxed Code Interpreter & Dynamic Computation

## 1. Goal & Architectural Boundary
Phase 10 equips UniversalWorkbench agents and workflows with safe, dynamic code execution:
- ReAct agents and workflow nodes can execute isolated computation scripts to process data, calculate statistics, format payloads, and transform objects.
- Strict isolation: executes in an isolated sandbox context with no access to host filesystem, network sockets, or process environment.
- Enforced resource quotas: strict timeout limit (default 3000ms, max 10000ms), captured standard output (stdout/stderr), and serialized results.

## 2. Core Pillars
### Pillar 1: Sandboxed Execution Engine
- Execution sandbox: isolated VM context evaluating scripts with safe globals (JSON, Math, Date, TextEncoder/Decoder) and mock console.
- Resource guards: timeout kill, memory boundaries, and fail-closed syntax/runtime error trapping.

### Pillar 2: Code Interpreter Tool Descriptor & Envelopes
- Tool descriptor: `builtin.code.interpreter@1.0.0` accepting `code_eval`, `json`, or `text` context.
- Output envelope: `code_result` context type containing `result`, `stdout`, `stderr`, and `durationMs`.
- Sub-agent and HITL integration: can be assigned to specialist sub-agents or tagged with `requiresApproval`.

### Pillar 3: Web UI Code Editor & Console Output Viewer
- Code editor interface in workflow steps with syntax styling.
- Interactive console log viewer in `AgentTraceViewer` and execution outputs.
