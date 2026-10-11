# Phase 8 Design Spec: Model Context Protocol (MCP) Client & Dynamic Tool Bridge

## 1. Goal & Architectural Boundary
Phase 8 connects UniversalWorkbench to the open Model Context Protocol (MCP) ecosystem:
- Enables users to configure external MCP servers (stdio and SSE transports).
- Dynamically discovers external tools and bridges them into the UniversalWorkbench ToolRegistry.
- Maintains strict Phase 5/6/7 security: secret resolution via Vault, whitelist permissions in workflows, and interactive Human-in-the-Loop (HITL) approval for destructive actions.

## 2. Core Pillars
### Pillar 1: MCP Server Configuration & Lifecycle
- Server configuration schema: transport (`stdio` | `sse`), command/args or URL, and environment variables with `secret://` resolution.
- Client lifecycle manager: connection pooling, health ping, graceful shutdown, and timeout handling.

### Pillar 2: Dynamic Tool Descriptor Bridge
- Tool reflection: Queries `tools/list` from connected MCP servers and synthesizes valid `ToolDescriptor` objects (`mcp.<server_id>.<tool_name>@1.0.0`).
- Execution translation: Maps UniversalWorkbench inputs to MCP `tools/call`, returning sanitized `ContextEnvelope` outputs.
- Security & HITL integration: Configurable `requiresApproval` flags on external tools to trigger Phase 7 approval suspensions.

### Pillar 3: Server Registry Injection & Web UI Settings
- Project-scoped MCP server storage and sync endpoints (`/api/projects/:id/mcp-servers`).
- Web UI settings view to register MCP servers, test connections, and inspect discovered tools.
