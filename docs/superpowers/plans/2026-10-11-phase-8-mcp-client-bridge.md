# Phase 8 Implementation Plan: MCP Client & Dynamic Tool Bridge

Branch: `phase-8-mcp-client-bridge`

---

### Task 1: MCP Server Contracts & Configuration Schemas

- **Target:** `packages/contracts/src/mcp.ts`, `packages/contracts/src/index.ts`
- **Output:** `McpServerConfigSchema` (stdio/sse transports, env with secretRef), `McpToolDescriptorSchema`.
- **Tests:** `packages/contracts/test/phase-8-contracts.test.ts`
- **Commit:** `feat(contracts): add mcp server config and tool schemas`

---

### Task 2: MCP Client Adapter & Protocol Bridge

- **Target:** `packages/tools/src/mcp/client.ts`, `packages/tools/src/mcp/adapter.ts`
- **Output:** Transport abstraction, tool discovery (`tools/list` -> `ToolDescriptor`), and tool runner (`tools/call` -> `ContextEnvelope`).
- **Tests:** `packages/tools/test/mcp-adapter.test.ts`
- **Commit:** `feat(tools): implement mcp client protocol bridge and tool adapter`

---

### Task 3: MCP Tool Registry Injection with HITL Support

- **Target:** `packages/tools/src/registry.ts`, `packages/tools/src/agent/dispatcher.ts`
- **Output:** Dynamic registration of MCP tools into ToolRegistry, secret resolution for MCP env, and configurable `requiresApproval` tagging.
- **Tests:** `packages/tools/test/mcp-registry.test.ts`
- **Commit:** `feat(tools): support dynamic mcp tool registration with hitl approval`

---

### Task 4: Server MCP Persistence & Management Endpoints

- **Target:** `packages/database/src/`, `apps/server/src/routes/mcp.ts`, `apps/server/src/composition.ts`
- **Output:** Database repository for MCP servers, CRUD API (`/api/projects/:id/mcp-servers`), sync discovered tools on startup.
- **Tests:** `apps/server/test/mcp-api.integration.test.ts`
- **Commit:** `feat(server): add mcp server management apis and persistence`

---

### Task 5: Web UI — MCP Server Settings & Tool Inspector

- **Target:** `apps/web/src/settings/McpSettings.tsx`, `apps/web/src/workflows/AgentStepEditor.tsx`
- **Output:** Form to configure MCP servers (stdio/sse), connection test button, tool list inspection, and MCP tool selection in AgentStepEditor.
- **Tests:** `apps/web/test/mcp-settings.test.tsx`
- **Commit:** `feat(web): add mcp server settings view and agent tool selection`

---

### Task 6: Golden Integration, Documentation Runbook, & Phase 8 Gate Pass

- **Target:** `packages/execution/test/golden-mcp.integration.test.ts`, `docs/architecture/phase-8.md`, `README.md`
- **Output:** E2E test (Agent uses dynamic MCP tool -> observes output -> completes task with HITL support), docs, and gate pass.
- **Commit:** `docs: close phase 8 mcp client bridge`
