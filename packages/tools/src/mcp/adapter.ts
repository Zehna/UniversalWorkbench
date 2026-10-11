import { ToolDescriptorSchema } from "@uw/contracts";
import type { ContextEnvelope, ToolDescriptor } from "@uw/contracts";
import { ToolRuntimeError } from "../errors.js";
import type { ToolExecutor } from "../runtime.js";
import { createLocalResult, validateInvocation } from "../runtime.js";
import type { McpCallToolResult, McpToolDefinition } from "./client.js";

export interface ConvertMcpToolOptions {
  requiresApproval?: boolean;
  version?: string;
}

export interface McpToolExecutorClient {
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallToolResult>;
}

function sanitizeSegment(value: string, fallback: string): string {
  const lowered = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  const stripped = lowered.replace(/^[_.-]+|[_.-]+$/g, "");
  if (stripped.length === 0) return fallback;
  return stripped.slice(0, 64);
}

function normalizeConfigSchema(
  inputSchema: McpToolDefinition["inputSchema"],
): Record<string, unknown> {
  if (
    typeof inputSchema === "object" &&
    inputSchema !== null &&
    !Array.isArray(inputSchema)
  ) {
    return { ...(inputSchema as Record<string, unknown>) };
  }
  return { type: "object" };
}

export function convertMcpToolToDescriptor(
  serverId: string,
  mcpTool: McpToolDefinition,
  options: ConvertMcpToolOptions = {},
): ToolDescriptor {
  if (!serverId || serverId.trim().length === 0) {
    throw new ToolRuntimeError("INVALID_INPUT", "MCP server id is invalid");
  }
  if (
    !mcpTool ||
    typeof mcpTool.name !== "string" ||
    mcpTool.name.trim().length === 0
  ) {
    throw new ToolRuntimeError("INVALID_INPUT", "MCP tool name is invalid");
  }
  const serverSegment = sanitizeSegment(serverId, "server");
  const toolSegment = sanitizeSegment(mcpTool.name, "tool");
  const id = `mcp.${serverSegment}.${toolSegment}`.slice(0, 128);
  const version = options.version ?? "1.0.0";
  const name = mcpTool.name.trim().slice(0, 120) || toolSegment;
  const rawDescription =
    typeof mcpTool.description === "string" && mcpTool.description.trim()
      ? mcpTool.description.trim()
      : `MCP tool ${mcpTool.name} from server ${serverId}`;
  const description = rawDescription.slice(0, 2000);

  return ToolDescriptorSchema.parse({
    id,
    version,
    name,
    description,
    accepts: ["json", "text"],
    produces: ["json", "text"],
    permissions: [],
    capabilities: ["mcp"],
    executionMode: "server",
    idempotency: "unsafe",
    configSchema: normalizeConfigSchema(mcpTool.inputSchema),
    requiresApproval: options.requiresApproval ?? false,
  });
}

export function convertMcpToolsToDescriptors(
  serverId: string,
  mcpTools: McpToolDefinition[],
  options: ConvertMcpToolOptions = {},
): ToolDescriptor[] {
  if (!Array.isArray(mcpTools)) {
    throw new ToolRuntimeError("INVALID_INPUT", "MCP tools list is invalid");
  }
  return mcpTools.map((tool) =>
    convertMcpToolToDescriptor(serverId, tool, options),
  );
}

function extractMcpArgs(input: ContextEnvelope): Record<string, unknown> {
  const payload = input.payload;
  if (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload)
  ) {
    return { ...(payload as Record<string, unknown>) };
  }
  return { value: payload };
}

function errorText(result: McpCallToolResult): string {
  const parts = (result.content ?? [])
    .filter((item) => typeof item?.text === "string")
    .map((item) => item.text as string)
    .filter((text) => text.trim().length > 0);
  return parts.length > 0 ? parts.join("\n") : "MCP tool reported an error";
}

function toOutput(result: McpCallToolResult): {
  type: "json" | "text";
  mimeType: string;
  payload: unknown;
} {
  if (result.structuredContent !== undefined) {
    return {
      type: "json",
      mimeType: "application/json",
      payload: result.structuredContent,
    };
  }
  const content = Array.isArray(result.content) ? result.content : [];
  if (content.length === 0) {
    return { type: "json", mimeType: "application/json", payload: null };
  }
  const texts: string[] = [];
  let allText = true;
  for (const item of content) {
    if (item?.type === "text" && typeof item.text === "string") {
      texts.push(item.text);
    } else {
      allText = false;
      break;
    }
  }
  if (allText) {
    return { type: "text", mimeType: "text/plain", payload: texts.join("\n") };
  }
  return {
    type: "json",
    mimeType: "application/json",
    payload: content,
  };
}

export function createMcpToolExecutor(
  client: McpToolExecutorClient,
  toolName: string,
  descriptor?: ToolDescriptor,
): ToolExecutor {
  if (!client || typeof client.callTool !== "function") {
    throw new ToolRuntimeError("INVALID_INPUT", "MCP client is invalid");
  }
  if (typeof toolName !== "string" || toolName.trim().length === 0) {
    throw new ToolRuntimeError("INVALID_INPUT", "MCP tool name is invalid");
  }
  const resolvedDescriptor =
    descriptor ??
    convertMcpToolToDescriptor("server", {
      name: toolName,
      inputSchema: { type: "object" },
    });

  return {
    descriptor: ToolDescriptorSchema.parse(resolvedDescriptor),
    async run(input, config, context) {
      const validInput = validateInvocation(resolvedDescriptor, input, context);
      void config;
      const args = extractMcpArgs(validInput);
      let result: McpCallToolResult;
      try {
        result = await client.callTool(toolName, args);
      } catch (error) {
        if (error instanceof ToolRuntimeError) throw error;
        throw new ToolRuntimeError(
          "NETWORK_FAILURE",
          error instanceof Error && error.message
            ? error.message
            : `MCP callTool ${toolName} failed`,
        );
      }
      if (result?.isError === true) {
        throw new ToolRuntimeError("NETWORK_FAILURE", errorText(result));
      }
      if (typeof result !== "object" || result === null) {
        throw new ToolRuntimeError(
          "INVALID_OUTPUT",
          "MCP tool returned a malformed result",
        );
      }
      return createLocalResult(
        resolvedDescriptor,
        validInput,
        context,
        toOutput(result),
      );
    },
  };
}
