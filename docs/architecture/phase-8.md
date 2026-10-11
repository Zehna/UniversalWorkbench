# Phase 8 Architecture — MCP Client & Dynamic Tool Bridge

> Implementation reference for the `phase-8-mcp-client-bridge` branch.
> Phase 8 connects UniversalWorkbench to the open Model Context Protocol
> (MCP) ecosystem: project-scoped MCP servers are configured in contracts,
> discovered over stdio (SSE is schema-supported), bridged into the
> version-pinned ToolRegistry as `mcp.<server>.<tool>@1.0.0` descriptors,
> and executed through the Phase 6 ReAct loop under Phase 5/7 security
> (Vault secrets, fail-closed whitelist, HITL approval). The release
> boundary is not closed until the Task 6 full gate — golden MCP
> integration, monorepo tests, and typechecks — passes on one final commit.

## 1. Scope and package boundaries

Phase 8 keeps Phase 2 local-first sync, Phase 3 DAG/workflow core, Phase 4
AI provider seam + token budgets, Phase 5 hardening, Phase 6 ReAct loop,
and Phase 7 HITL/streaming/parallel dispatch unchanged in behavior, and
adds MCP configuration, bridging, persistence, and settings UI in existing
packages (no new top-level package):

| Package         | Responsibility                                                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@uw/contracts` | `McpServerConfigSchema` (discriminated `stdio` / `sse` transports, env, `secretRefs`), `McpToolMetadataSchema`, create/update request schemas; `requiresApproval` stays on `ToolDescriptor`.                                                                         |
| `@uw/tools`     | `McpTransport` abstraction + `McpClient` lifecycle, `StdioProcessTransport` (JSON-RPC over stdio), `InMemoryMcpTransport` test double, `convertMcpToolToDescriptor(s)` + `createMcpToolExecutor`, `registerMcpTools` / `unregisterMcpServerTools` / `resolveMcpEnv`. |
| `@uw/execution` | No engine changes; golden MCP suite proves the ReAct + HITL loop works unchanged over dynamic MCP executors (`packages/execution/test/golden-mcp.integration.test.ts`).                                                                                              |
| `@uw/database`  | `McpServerRepository` (Postgres `mcp_servers` table + in-memory test double), owner/project-scoped CRUD.                                                                                                                                                             |
| `apps/server`   | `POST/GET/PATCH/DELETE /api/projects/:id/mcp-servers`, `POST /:serverId/sync` discovery + registry injection, owner-scoped auth with 404 concealment.                                                                                                                |
| `apps/web`      | `McpSettings` (stdio/SSE form, connection test/sync, discovered-tool inspection) and `AgentStepEditor` MCP tool selection.                                                                                                                                           |

Dependency direction stays acyclic:

```text
contracts <- tools <- execution <- server <- web (composition only)
tools <- database (structural repository port, no cross-import)
providers + tools <- server (structural AgentProviderPort, no cross-import)
```

`@uw/tools` never imports `@uw/providers`, `@uw/execution`, or
`@uw/database`. The server composes engine + dispatcher + providers +
registry; the web client only speaks HTTP.

## 2. MCP client architecture (stdio and SSE transport lifecycle)

Contracts (`packages/contracts/src/mcp.ts`) model two transports behind one
discriminated union:

```ts
McpServerTransportConfigSchema = discriminatedUnion("transport", [
  McpStdioConfigSchema, // { transport: "stdio", command, args, env }
  McpSseConfigSchema, // { transport: "sse", url, headers }
]);
```

`McpServerConfigSchema` adds `id`, optional `projectId`, `name`, `enabled`
(default `true`), `transportConfig`, `secretRefs` (default `[]`), and
optional timestamps. `McpToolMetadataSchema` carries `serverId`,
`serverName`, `toolName`, optional `description`, `inputSchema`, and
`requiresApproval` (default `false`).

The runtime surface (`packages/tools/src/mcp/client.ts`) is transport
agnostic:

```ts
interface McpTransport {
  connect(): Promise<void>;
  listTools(): Promise<McpToolDefinition[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallToolResult>;
  close(): Promise<void>;
}
```

`McpClient` owns the lifecycle every transport shares:

```text
new McpClient(transport, { timeoutMs? })  // default 10_000 ms
connect()    -> transport.connect() with timeout; connected = true
listTools()  -> assert connected; transport.listTools() with timeout; assertToolList (array + non-empty names) else INVALID_OUTPUT
callTool()   -> assert connected; validate name/args (INVALID_INPUT); transport.callTool() with timeout; malformed null -> INVALID_OUTPUT
close()      -> transport.close(); connected = false (errors surface as NETWORK_FAILURE/TIMEOUT, never transport internals)
```

Timeouts race every operation (`withTimeout`); error mapping is fixed:
`TIMEOUT` on expiry, `NETWORK_FAILURE` on connection/call/close failure,
`INVALID_INPUT` on bad names/args, `INVALID_OUTPUT` on malformed tools or
results.

Transports shipped:

- `StdioProcessTransport` (`command`, `args`, `env`, `timeoutMs`): spawns
  the server once on `connect()` (`child_process.spawn` with
  `stdio: ["pipe", "pipe", "pipe"]`), speaks newline-delimited JSON-RPC 2.0
  (`tools/list` → `{ tools }`, `tools/call` → `{ name, arguments }`),
  multiplexes responses by numeric `id` in a pending map with per-request
  timeouts, ignores unparsable lines, rejects unknown ids, and on `close()`
  rejects all pending requests then kills the child (`SIGTERM`, `SIGKILL`
  after 1 s). `listTools` validates through the same `assertToolList`
  gate; a malformed `tools/call` result throws before reaching the client.
- `InMemoryMcpTransport` (test/dev double): same interface over preset
  `tools` + per-tool `results` with optional `delayMs`; `callTool` returns
  a structured clone of the preset or echoes `{ content: [{ type: "text",
text: JSON.stringify(args) }] }`. The golden MCP suite and the
  `mcp-adapter` / `mcp-registry` suites run entirely on this double — no
  test spawns a real process or sends real network traffic.
- SSE lifecycle: `McpSseConfigSchema` (`url`, `headers`) is a first-class
  persisted configuration (server CRUD, web form, and secret-ref
  resolution all accept it), but live `sync` discovery in
  `apps/server/src/routes/mcp.ts` is stdio-only today: `defaultDiscoverTools`
  spawns a `StdioProcessTransport` from the non-`secret://` env subset and
  returns `502 SYNC_FAILED` for non-stdio transports. SSE servers persist,
  render, and validate; only the execution-time sync path is deferred.

Server sync lifecycle (`POST /:serverId/sync`):

```text
load server (owner+project scope, else 404)
  -> discover(server) [injected double in tests; default stdio transport in prod]
  -> unregisterMcpServerTools(registry, server.id) (best-effort, ignored on first sync)
  -> registerMcpTools(registry, server.id, mcpTools, executorClient)
  -> 200 { server, tools }
```

`DELETE /:serverId` removes persistence then best-effort unregisters that
server's `mcp.<server>.*` tools. All MCP routes require owner auth (401
otherwise) and conceal cross-owner/missing servers as 404, matching the
Phase 5 IDOR rule.

## 3. Dynamic ToolDescriptor bridge and ContextEnvelope mapping

Discovery (`tools/list` → descriptors) lives in
`packages/tools/src/mcp/adapter.ts`:

```ts
convertMcpToolToDescriptor(serverId, mcpTool, { requiresApproval?, version? })
convertMcpToolsToDescriptors(serverId, mcpTools, options)
```

Rules:

- `serverId` and `mcpTool.name` must be non-empty (`INVALID_INPUT`
  otherwise); each segment is sanitized (`lowercase`, `[^a-z0-9]+` → `_`,
  trim edge separators, fallback `"server"` / `"tool"`, cap 64 chars).
- `id = "mcp.<serverSegment>.<toolSegment>"` (sliced to 128 chars, satisfies
  `ToolDescriptorSchema`), `version` defaults to `"1.0.0"` (exact semver),
  `name` is the trimmed MCP name (≤120), `description` is the trimmed MCP
  description or `"MCP tool <name> from server <serverId>"` (≤2000).
- Fixed bridge contract: `accepts: ["json", "text"]`, `produces: ["json",
"text"]`, `permissions: []`, `capabilities: ["mcp"]`, `executionMode:
"server"`, `idempotency: "unsafe"`, `configSchema` is the MCP
  `inputSchema` when it is a plain object else `{ type: "object" }`,
  `requiresApproval` defaults to `false` and is the only HITL knob.

Execution (`tools/call` → envelopes) lives in `createMcpToolExecutor(client,
toolName, descriptor?)`:

```text
run(input, config, context):
  validInput = validateInvocation(descriptor, input, context)  // type in accepts + permissions granted + envelope valid
  args = extractMcpArgs(validInput)  // object payload spread; non-object payload -> { value: payload }; config is intentionally ignored
  result = await client.callTool(toolName, args)  // transport errors surface as ToolRuntimeError
  isError === true -> throw NETWORK_FAILURE with joined text content
  structuredContent !== undefined -> json envelope (application/json, payload = structuredContent)
  content == [] -> json envelope (payload null)
  all content items are { type: "text", text } -> text envelope (text/plain, payload joined with "\n")
  mixed/non-text content -> json envelope (payload = content array)
  wrap via createLocalResult (derived SHA-256 id, provenance from input)
```

Registry injection (`packages/tools/src/mcp/registry.ts`):

- `registerMcpTools(registry, serverId, mcpTools, client, options)` converts
  each MCP tool, builds its executor bound to the originating `mcpTool.name`
  (not the synthesized id), registers it (exact `id@version` pinning;
  re-registering throws `DUPLICATE_TOOL`), and returns the descriptors.
- `unregisterMcpServerTools(registry, serverId)` removes every descriptor
  under the `mcp.<sanitizedServer>.` prefix and returns sorted
  `"id@version"` strings (`TOOL_NOT_FOUND` surfaces as a typed registry
  error when misused).
- `resolveMcpEnv(env, resolveSecret, ownerId?)` resolves only values
  starting with `secret://` via `resolveSecret(ref, ownerId)` and passes
  literals through; resolver failures become `INVALID_CONFIG` / remapped
  `ToolRuntimeError` without leaking resolver detail.

Because bridged executors are ordinary `ToolExecutor`s, the Phase 6 agent
needs no code changes: `AgentToolDispatcher` lists them as
`mcp.<server>.<tool>@1.0.0` function-calling specs, the provider requests
them by that pinned name, and `runTool` validates + persists them like any
built-in. The golden MCP suite proves discovery (`connect` → `listTools` →
`registerMcpTools`), execution (provider tool-call → MCP `callTool` →
observation → final answer with trace/tokens/receipt), and id format in one
run.

## 4. Security model: Vault secrets, fail-closed whitelist, HITL guardrails

Vault secret resolution:

- Both the agent (`resolveSecret(ref, ownerId)` per invocation) and MCP env
  (`resolveMcpEnv`) resolve `secret://` references at run time under the
  owner scope. `secret://vault/*` decrypts via the server vault
  (AES-256-GCM envelope + versioned keyring, Phase 4);
  `secret://local/*` stays on-device and fails closed on the server.
- Server sync deliberately strips `secret://` env values before spawning
  stdio discovery (only plaintext env reaches the child); persisted
  `secretRefs` carry the references, never the plaintext.
- Before persistence, `scrubSecret` + `scrubTraceValue` deep-replace the
  resolved plaintext across final text, thoughts, tool-call arguments,
  observation outputs, and the error-throw path with `[REDACTED]`; the
  engine additionally stores `redactSecrets(inputContext)` step snapshots.
  Golden MCP tests use an `MCP_CANARY` vault value and substring-scan the
  full completed/resumed view + receipt for absence, mirroring the Phase 6
  `AGENT_CANARY` and Phase 7 `HITL_CANARY` guarantees.

Fail-closed whitelist permissions:

- The agent can only invoke `allowedTools`-listed pinned names
  (`AiAgentConfigSchema.allowedTools`, default `[]`). `dispatch` returns
  `UNAUTHORIZED_TOOL` error observations for missing/unlisted names and
  `UNKNOWN_TOOL` for allowed-but-unregistered names; content (including MCP
  observations, serialized as JSON context) can never widen the server
  permission grant, the agent is excluded from its own dispatch set, and
  `dispatchMany` isolates one tool's throw as a per-call
  `TOOL_EXECUTION_FAILED` observation via `Promise.allSettled` (Phase 7).
- `validateInvocation` enforces `descriptor.accepts` (MCP tools accept only
  `json`/`text`) and `descriptor.permissions` (MCP tools declare `[]`, so
  they run under the workflow's granted set — the golden suite grants only
  `{"ai"}`); violations throw `INVALID_INPUT` / `PERMISSION_DENIED` before
  any transport call. Production workflow `network`/`ai` permissions are
  not granted by default.

Phase 7 HITL approval guardrails (unchanged, exercised over MCP tools):

- MCP tools opt in per registration (`registerMcpTools(..., {
requiresApproval: true })` → descriptor `requiresApproval: true`). The
  dispatcher gate is orthogonal to the whitelist: a tool must be both allowed
  _and_ approved to run — unapproved gated calls return `{ requiresApproval:
true, pendingApproval: { tool, toolCallId?, arguments, reason } }` without
  touching the transport.
- `createAgentTool` stops the ReAct loop on any approval observation with
  `{ status: "awaiting_approval", structured: { pendingApprovals: [...] } }`;
  the engine suspends (`running` → `awaiting_approval`, persisted step +
  usage), `resolveApproval({ decision, rejectionReason? })` validates state
  and input, stores a resolution map keyed by both `toolCallId` and tool
  name, resumes (`awaiting_approval` → `running`), and re-enters `process()`
  with `approvalResolutions` injected. Approved MCP calls execute;
  rejected calls become `"Action was rejected by user: <reason>"` error
  observations fed back into the conversation so the agent completes
  alternatively without ever invoking the gated executor (unsafe descriptors
  reuse the suspending attempt window instead of double-executing).
- The golden MCP HITL test asserts the full suspension (`awaiting_approval`
  status + step, `pendingApprovals[0].tool === "mcp.golden.lookup@1.0.0"`,
  `callTool` not called) and the approved resume (`completed`, `callTool`
  called once, final text contains the MCP observation, receipt completed,
  no canary leak).

## 5. Release gate (Task 6)

```sh
npm run test -w @uw/execution              # engine + golden MCP/HITL/agent/AI/workflow suites
npm run test -w @uw/tools                  # MCP adapter/registry + agent dispatcher HITL suites
npm run test -w @uw/contracts              # MCP server config + agent/HITL schema suites
npm run test -w @uw/server                 # MCP management API + HITL/SSE suites
npm run test -w @uw/web                    # MCP settings + ApprovalCard/AgentTraceViewer suites
npm run typecheck --workspace=@uw/web      # zero TypeScript errors (requiresApproval on mocks)
npm test                                   # all workspace suites
npm run typecheck                          # zero TypeScript errors repo-wide
```

`packages/execution/test/golden-mcp.integration.test.ts` is the Phase 8
golden gate: (1) ReAct over mock MCP (`connect` → `listTools` →
`mcp.golden.lookup@1.0.0` → observation `42`/`Paris` → `completed` with
trace, token accounting, receipt, and no secret leak); (2) HITL over a
`requiresApproval` MCP tool (agent → `awaiting_approval` suspend → approve
→ MCP tool runs once → `completed` with receipt + no secret leak).
DB-backed suites need `TEST_DATABASE_URL`; no test sends real network
traffic (deterministic `InMemoryMcpTransport` + injected providers) or
weakens the production egress policy.

## 6. Non-goals carried forward

Live SSE `tools/list` + `tools/call` streaming transport, MCP OAuth /
per-tool auth, multi-server tool-name federation beyond the
`mcp.<server>.<tool>` prefix, multi-agent orchestration, arbitrary
shell/code execution as agent tools, multi-step approval chains / delegated
approvers, billing/teams/marketplace, Redis, and Kubernetes remain out of
scope per the product blueprint.
