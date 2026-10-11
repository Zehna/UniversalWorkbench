import type { ToolDescriptor } from "@uw/contracts";
import { ToolRuntimeError } from "../errors.js";
import type { ToolRegistry } from "../registry.js";
import {
  convertMcpToolToDescriptor,
  createMcpToolExecutor,
  type ConvertMcpToolOptions,
  type McpToolExecutorClient,
} from "./adapter.js";
import type { McpToolDefinition } from "./client.js";

export type { ConvertMcpToolOptions };
export type McpSecretResolver = (
  ref: string,
  ownerId?: string,
) => Promise<string>;

function sanitizeSegment(value: string, fallback: string): string {
  const lowered = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  const stripped = lowered.replace(/^[_.-]+|[_.-]+$/g, "");
  if (stripped.length === 0) return fallback;
  return stripped.slice(0, 64);
}

export function registerMcpTools(
  registry: ToolRegistry,
  serverId: string,
  mcpTools: McpToolDefinition[],
  client: McpToolExecutorClient,
  options: ConvertMcpToolOptions = {},
): ToolDescriptor[] {
  if (!registry || typeof registry.register !== "function") {
    throw new ToolRuntimeError("INVALID_INPUT", "Tool registry is invalid");
  }
  if (!serverId || serverId.trim().length === 0) {
    throw new ToolRuntimeError("INVALID_INPUT", "MCP server id is invalid");
  }
  if (!client || typeof client.callTool !== "function") {
    throw new ToolRuntimeError("INVALID_INPUT", "MCP client is invalid");
  }
  if (!Array.isArray(mcpTools)) {
    throw new ToolRuntimeError("INVALID_INPUT", "MCP tools list is invalid");
  }
  const descriptors: ToolDescriptor[] = [];
  for (const mcpTool of mcpTools) {
    const descriptor = convertMcpToolToDescriptor(serverId, mcpTool, options);
    const executor = createMcpToolExecutor(client, mcpTool.name, descriptor);
    registry.register(executor);
    descriptors.push(descriptor);
  }
  return descriptors;
}

export function unregisterMcpServerTools(
  registry: ToolRegistry,
  serverId: string,
): string[] {
  if (!registry || typeof registry.list !== "function") {
    throw new ToolRuntimeError("INVALID_INPUT", "Tool registry is invalid");
  }
  if (!serverId || serverId.trim().length === 0) {
    throw new ToolRuntimeError("INVALID_INPUT", "MCP server id is invalid");
  }
  const prefix = `mcp.${sanitizeSegment(serverId, "server")}.`;
  const removed: string[] = [];
  for (const descriptor of registry.list()) {
    if (descriptor.id.startsWith(prefix)) {
      registry.unregister(descriptor.id, descriptor.version);
      removed.push(`${descriptor.id}@${descriptor.version}`);
    }
  }
  return removed.sort();
}

export async function resolveMcpEnv(
  env: Record<string, string>,
  resolveSecret: McpSecretResolver,
  ownerId?: string,
): Promise<Record<string, string>> {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new ToolRuntimeError("INVALID_INPUT", "MCP env map is invalid");
  }
  if (typeof resolveSecret !== "function") {
    throw new ToolRuntimeError(
      "INVALID_INPUT",
      "MCP secret resolver is invalid",
    );
  }
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.trim().startsWith("secret://")) {
      try {
        resolved[key] = await resolveSecret(value, ownerId);
      } catch (error) {
        if (error instanceof ToolRuntimeError) {
          throw new ToolRuntimeError(
            error.code,
            "MCP secret could not be resolved",
          );
        }
        throw new ToolRuntimeError(
          "INVALID_CONFIG",
          "MCP secret could not be resolved",
        );
      }
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}
