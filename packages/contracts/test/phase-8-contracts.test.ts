import { describe, expect, it } from "vitest";
import {
  CreateMcpServerRequestSchema,
  McpServerConfigSchema,
  McpServerTransportConfigSchema,
  McpSseConfigSchema,
  McpStdioConfigSchema,
  McpToolMetadataSchema,
  McpTransportTypeSchema,
  UpdateMcpServerRequestSchema,
} from "../src/index.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SERVER_ID = "22222222-2222-4222-8222-222222222222";

describe("phase 8 mcp contracts", () => {
  it("parses valid stdio transport and applies defaults", () => {
    const parsed = McpStdioConfigSchema.parse({
      transport: "stdio",
      command: "npx",
    });
    expect(parsed.transport).toBe("stdio");
    expect(parsed.command).toBe("npx");
    expect(parsed.args).toEqual([]);
    expect(parsed.env).toEqual({});
  });

  it("parses stdio transport with explicit args and env", () => {
    const parsed = McpStdioConfigSchema.parse({
      transport: "stdio",
      command: "node",
      args: ["server.js", "--port", "3000"],
      env: { API_KEY: "secret://vault/api-key" },
    });
    expect(parsed.args).toEqual(["server.js", "--port", "3000"]);
    expect(parsed.env).toEqual({ API_KEY: "secret://vault/api-key" });
  });

  it("parses McpTransportTypeSchema values", () => {
    expect(McpTransportTypeSchema.parse("stdio")).toBe("stdio");
    expect(McpTransportTypeSchema.parse("sse")).toBe("sse");
  });

  it("parses valid sse transport and applies header defaults", () => {
    const parsed = McpSseConfigSchema.parse({
      transport: "sse",
      url: "https://example.com/mcp/sse",
    });
    expect(parsed.transport).toBe("sse");
    expect(parsed.url).toBe("https://example.com/mcp/sse");
    expect(parsed.headers).toEqual({});
  });

  it("rejects invalid sse urls", () => {
    expect(
      McpSseConfigSchema.safeParse({
        transport: "sse",
        url: "not-a-url",
      }).success,
    ).toBe(false);
    expect(
      McpSseConfigSchema.safeParse({
        transport: "sse",
      }).success,
    ).toBe(false);
  });

  it("parses discriminated union transport configs by transport key", () => {
    const stdio = McpServerTransportConfigSchema.parse({
      transport: "stdio",
      command: "npx",
      args: ["-y", "mcp-server"],
    });
    expect(stdio.transport).toBe("stdio");

    const sse = McpServerTransportConfigSchema.parse({
      transport: "sse",
      url: "https://example.com/events",
    });
    expect(sse.transport).toBe("sse");
  });

  it("rejects invalid transport or missing required fields", () => {
    expect(
      McpServerTransportConfigSchema.safeParse({
        transport: "websocket",
        url: "https://example.com",
      }).success,
    ).toBe(false);
    expect(
      McpServerTransportConfigSchema.safeParse({
        transport: "stdio",
      }).success,
    ).toBe(false);
    expect(McpTransportTypeSchema.safeParse("websocket").success).toBe(false);
    expect(
      McpServerConfigSchema.safeParse({
        id: SERVER_ID,
        name: "missing transport",
        enabled: true,
      }).success,
    ).toBe(false);
  });

  it("validates secretRefs integration with SecretRefSchema", () => {
    const parsed = McpServerConfigSchema.parse({
      id: SERVER_ID,
      projectId: PROJECT_ID,
      name: "my server",
      enabled: true,
      transportConfig: { transport: "stdio", command: "npx" },
      secretRefs: ["secret://vault/api-key", "secret://local/token_1"],
    });
    expect(parsed.secretRefs).toEqual([
      "secret://vault/api-key",
      "secret://local/token_1",
    ]);
  });

  it("rejects invalid secretRefs", () => {
    expect(
      McpServerConfigSchema.safeParse({
        id: SERVER_ID,
        name: "bad secrets",
        enabled: true,
        transportConfig: { transport: "stdio", command: "npx" },
        secretRefs: ["not-a-secret-ref"],
      }).success,
    ).toBe(false);
    expect(
      McpServerConfigSchema.safeParse({
        id: SERVER_ID,
        name: "bad secrets",
        enabled: true,
        transportConfig: { transport: "stdio", command: "npx" },
        secretRefs: ["secret://unknown/name"],
      }).success,
    ).toBe(false);
  });

  it("parses McpToolMetadataSchema with requiresApproval flag", () => {
    const base = {
      serverId: SERVER_ID,
      serverName: "my server",
      toolName: "search",
      inputSchema: { type: "object" },
    };
    const defaulted = McpToolMetadataSchema.parse({ ...base });
    expect(defaulted.requiresApproval).toBe(false);

    const approved = McpToolMetadataSchema.parse({
      ...base,
      description: "search the web",
      requiresApproval: true,
    });
    expect(approved.requiresApproval).toBe(true);
    expect(approved.description).toBe("search the web");
  });

  it("rejects tool metadata missing required fields", () => {
    expect(
      McpToolMetadataSchema.safeParse({
        serverName: "my server",
        toolName: "search",
        inputSchema: { type: "object" },
      }).success,
    ).toBe(false);
  });

  it("parses create and update server requests", () => {
    const created = CreateMcpServerRequestSchema.parse({
      projectId: PROJECT_ID,
      name: "new server",
      transportConfig: { transport: "sse", url: "https://example.com/sse" },
    });
    expect(created.name).toBe("new server");

    const updated = UpdateMcpServerRequestSchema.parse({
      name: "renamed",
      enabled: false,
    });
    expect(updated.name).toBe("renamed");
    expect(updated.enabled).toBe(false);
    expect(UpdateMcpServerRequestSchema.safeParse({}).success).toBe(false);
  });
});
