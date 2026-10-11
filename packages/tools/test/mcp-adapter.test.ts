import type { ContextEnvelope } from "@uw/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryMcpTransport,
  McpClient,
  type McpCallToolResult,
  type McpToolDefinition,
} from "../src/mcp/client.js";
import {
  convertMcpToolToDescriptor,
  convertMcpToolsToDescriptors,
  createMcpToolExecutor,
} from "../src/mcp/adapter.js";
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

describe("mcp adapter tool discovery", () => {
  it("converts an MCP tools list to valid ToolDescriptors", async () => {
    const transport = new InMemoryMcpTransport([searchTool]);
    const client = new McpClient(transport);
    await client.connect();
    const tools = await client.listTools();
    const descriptors = convertMcpToolsToDescriptors("server1", tools);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      id: "mcp.server1.search",
      version: "1.0.0",
      name: "search",
      description: "Search the web",
    });
    expect(descriptors[0]?.accepts).toContain("json");
    expect(descriptors[0]?.produces).toEqual(
      expect.arrayContaining(["json", "text"]),
    );
    await client.close();
  });

  it("converts a single MCP tool with exact version and schemas", () => {
    const descriptor = convertMcpToolToDescriptor("server1", searchTool);
    expect(`${descriptor.id}@${descriptor.version}`).toBe(
      "mcp.server1.search@1.0.0",
    );
    expect(descriptor.configSchema).toMatchObject({ type: "object" });
  });
});

describe("mcp adapter tool execution", () => {
  it("calls callTool and produces a valid ContextEnvelope", async () => {
    const transport = new InMemoryMcpTransport([searchTool], {
      search: { content: [{ type: "text", text: "hello world" }] },
    });
    const client = new McpClient(transport);
    await client.connect();
    const descriptor = convertMcpToolToDescriptor("server1", searchTool);
    const executor = createMcpToolExecutor(client, "search", descriptor);
    const result = await runTool(
      executor,
      jsonInput({ query: "hi" }),
      {},
      baseContext,
    );
    expect(result.outputs).toHaveLength(1);
    expect(["json", "text"]).toContain(result.outputs[0]?.type);
    expect(result.outputs[0]?.payload).toBe("hello world");
  });

  it("returns structured content as json envelopes", async () => {
    const structured: McpCallToolResult = {
      content: [{ type: "text", text: "ignored" }],
      structuredContent: { answer: 42 },
    };
    const transport = new InMemoryMcpTransport([searchTool], {
      search: structured,
    });
    const client = new McpClient(transport);
    await client.connect();
    const descriptor = convertMcpToolToDescriptor("server1", searchTool);
    const result = await runTool(
      createMcpToolExecutor(client, "search", descriptor),
      jsonInput({ query: "hi" }),
      {},
      baseContext,
    );
    expect(result.outputs[0]?.type).toBe("json");
    expect(result.outputs[0]?.payload).toEqual({ answer: 42 });
  });
});

describe("mcp adapter error handling", () => {
  it("wraps isError results as failures", async () => {
    const transport = new InMemoryMcpTransport([searchTool], {
      search: { content: [{ type: "text", text: "boom" }], isError: true },
    });
    const client = new McpClient(transport);
    await client.connect();
    const descriptor = convertMcpToolToDescriptor("server1", searchTool);
    await expect(
      runTool(
        createMcpToolExecutor(client, "search", descriptor),
        jsonInput({ query: "hi" }),
        {},
        baseContext,
      ),
    ).rejects.toMatchObject({ name: "ToolRuntimeError" });
  });

  it("wraps thrown transport errors", async () => {
    const callTool = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const transport = new InMemoryMcpTransport([searchTool]);
    transport.callTool = callTool;
    const client = new McpClient(transport);
    await client.connect();
    const descriptor = convertMcpToolToDescriptor("server1", searchTool);
    await expect(
      runTool(
        createMcpToolExecutor(client, "search", descriptor),
        jsonInput({ query: "hi" }),
        {},
        baseContext,
      ),
    ).rejects.toMatchObject({ name: "ToolRuntimeError" });
    expect(callTool).toHaveBeenCalledWith(
      "search",
      expect.objectContaining({ query: "hi" }),
    );
  });

  it("maps client timeouts to TIMEOUT errors", async () => {
    const transport = new InMemoryMcpTransport([searchTool]);
    transport.callTool = async () => new Promise<McpCallToolResult>(() => {});
    const client = new McpClient(transport, { timeoutMs: 20 });
    await client.connect();
    await expect(
      client.callTool("search", { query: "hi" }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    await client.close();
  });
});

describe("mcp adapter approval flag", () => {
  it("reflects requiresApproval when specified", () => {
    const plain = convertMcpToolToDescriptor("server1", searchTool);
    expect(plain.requiresApproval).toBe(false);
    const gated = convertMcpToolToDescriptor("server1", searchTool, {
      requiresApproval: true,
    });
    expect(gated.requiresApproval).toBe(true);
  });
});
