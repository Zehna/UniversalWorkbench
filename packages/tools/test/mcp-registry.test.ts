import type { ContextEnvelope } from "@uw/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentToolDispatcher,
  createTextTrimTool,
  createToolRegistry,
  InMemoryMcpTransport,
  McpClient,
  ToolRegistryError,
  type McpToolDefinition,
} from "../src/index.js";
import {
  registerMcpTools,
  resolveMcpEnv,
  unregisterMcpServerTools,
} from "../src/mcp/registry.js";
import { runTool, type ToolRunContext } from "../src/index.js";

const baseContext: ToolRunContext = {
  executionId: "22222222-2222-4222-8222-222222222222",
  stepId: "33333333-3333-4333-8333-333333333333",
  projectId: "44444444-4444-4444-8444-444444444444",
  traceId: "55555555-5555-4555-8555-555555555555",
  signal: new AbortController().signal,
  permissions: new Set(),
};

function jsonInput(payload: unknown): ContextEnvelope {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    type: "json",
    schemaVersion: 1,
    mimeType: "application/json",
    metadata: {},
    payload,
    provenance: { sourceContextIds: [] },
    capabilities: [],
  };
}

const searchTool: McpToolDefinition = {
  name: "search",
  description: "Search the web",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

describe("ToolRegistry unregister", () => {
  it("removes an exact pinned version and leaves other versions", () => {
    const registry = createToolRegistry();
    const v1 = createTextTrimTool();
    const v2 = {
      ...createTextTrimTool(),
      descriptor: { ...createTextTrimTool().descriptor, version: "2.0.0" },
    };
    registry.register(v1);
    registry.register(v2);

    registry.unregister(v1.descriptor.id, "1.0.0");

    expect(() => registry.resolve(v1.descriptor.id, "1.0.0")).toThrowError(
      ToolRegistryError,
    );
    expect(registry.resolve(v1.descriptor.id, "2.0.0").descriptor.version).toBe(
      "2.0.0",
    );
    expect(registry.list().map((tool) => tool.version)).toEqual(["2.0.0"]);
  });

  it("reports a typed error when unregistering a missing tool", () => {
    const registry = createToolRegistry();
    expect(() => registry.unregister("missing.tool", "1.0.0")).toThrow(
      expect.objectContaining({ code: "TOOL_NOT_FOUND" }),
    );
  });
});

describe("registerMcpTools", () => {
  it("registers discovered MCP tools with server-scoped ids", async () => {
    const registry = createToolRegistry();
    const transport = new InMemoryMcpTransport([searchTool], {
      search: { content: [{ type: "text", text: "hello" }] },
    });
    const client = new McpClient(transport);
    await client.connect();

    const descriptors = registerMcpTools(
      registry,
      "server1",
      [searchTool],
      client,
    );

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
      "mcp.server1.search",
    ]);
    const resolved = registry.resolve("mcp.server1.search", "1.0.0");
    expect(resolved.descriptor.requiresApproval).toBe(false);
    const result = await runTool(
      resolved,
      jsonInput({ query: "hi" }),
      {},
      baseContext,
    );
    expect(result.outputs[0]?.payload).toBe("hello");
    await client.close();
  });

  it("tags registered tools with requiresApproval for HITL", () => {
    const registry = createToolRegistry();
    const transport = new InMemoryMcpTransport([searchTool]);
    const client = new McpClient(transport);

    const descriptors = registerMcpTools(
      registry,
      "server1",
      [searchTool],
      client,
      {
        requiresApproval: true,
      },
    );

    expect(descriptors[0]?.requiresApproval).toBe(true);
    expect(
      registry.resolve("mcp.server1.search", "1.0.0").descriptor
        .requiresApproval,
    ).toBe(true);
  });

  it("rejects duplicate registration with DUPLICATE_TOOL", () => {
    const registry = createToolRegistry();
    const transport = new InMemoryMcpTransport([searchTool]);
    const client = new McpClient(transport);

    registerMcpTools(registry, "server1", [searchTool], client);
    expect(() =>
      registerMcpTools(registry, "server1", [searchTool], client),
    ).toThrow(expect.objectContaining({ code: "DUPLICATE_TOOL" }));
  });
});

describe("unregisterMcpServerTools", () => {
  it("removes only the named server's tools", () => {
    const registry = createToolRegistry();
    const transport = new InMemoryMcpTransport([searchTool]);
    const client = new McpClient(transport);

    registerMcpTools(registry, "server-a", [searchTool], client);
    registerMcpTools(
      registry,
      "server-b",
      [{ name: "other", inputSchema: { type: "object" } }],
      client,
    );

    const removed = unregisterMcpServerTools(registry, "server-a");

    expect(removed).toEqual(["mcp.server_a.search@1.0.0"]);
    expect(registry.list().map((tool) => tool.id)).toEqual([
      "mcp.server_b.other",
    ]);
  });
});

describe("resolveMcpEnv", () => {
  it("resolves secret:// values and leaves literals untouched", async () => {
    const resolveSecret = vi.fn(async (ref: string) => `resolved:${ref}`);

    const resolved = await resolveMcpEnv(
      { API_KEY: "secret://vault/api-key", PLAIN: "hello" },
      resolveSecret,
    );

    expect(resolved).toEqual({
      API_KEY: "resolved:secret://vault/api-key",
      PLAIN: "hello",
    });
    expect(resolveSecret).toHaveBeenCalledWith(
      "secret://vault/api-key",
      undefined,
    );
  });

  it("throws INVALID_CONFIG without leaking resolver detail", async () => {
    const resolveSecret = vi.fn(async () => {
      throw new Error("vault exploded with super-secret-bytes");
    });

    await expect(
      resolveMcpEnv({ API_KEY: "secret://vault/api-key" }, resolveSecret),
    ).rejects.toMatchObject({
      name: "ToolRuntimeError",
      code: "INVALID_CONFIG",
    });
  });
});

describe("MCP registry HITL approval", () => {
  it("suspends MCP tools tagged requiresApproval via the dispatcher", async () => {
    const registry = createToolRegistry();
    const transport = new InMemoryMcpTransport([searchTool], {
      search: { content: [{ type: "text", text: "done" }] },
    });
    const client = new McpClient(transport);
    await client.connect();
    registerMcpTools(registry, "server1", [searchTool], client, {
      requiresApproval: true,
    });

    const dispatcher = createAgentToolDispatcher({
      tools: registry
        .list()
        .map((descriptor) =>
          registry.resolve(descriptor.id, descriptor.version),
        ),
      allowedTools: ["mcp.server1.search@1.0.0"],
    });

    const pending = await dispatcher.dispatch(
      { name: "mcp.server1.search@1.0.0", arguments: {} },
      jsonInput({ query: "hi" }),
      baseContext,
    );
    expect(pending.requiresApproval).toBe(true);
    expect(pending.pendingApproval?.tool).toBe("mcp.server1.search@1.0.0");

    const approved = await dispatcher.dispatch(
      { name: "mcp.server1.search@1.0.0", arguments: {} },
      jsonInput({ query: "hi" }),
      baseContext,
      { decision: "approved" },
    );
    expect(approved.isError).toBe(false);
    await client.close();
  });
});
