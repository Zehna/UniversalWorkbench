import type { ContextType, ToolDescriptor } from "@uw/contracts";

/** Output types the server can persist as notes or artifacts. */
export const SAVABLE_OUTPUT_TYPES: readonly ContextType[] = [
  "ai_response",
  "agent_response",
  "text",
  "markdown",
];

export type SendToKind = "note" | "artifact" | "tool";

export interface SendToCandidate {
  kind: SendToKind;
  label: string;
  detail: string;
  toolId?: string;
  toolVersion?: string;
  requiresPermissions: string[];
}

/**
 * Candidate destinations generated from Context Bus compatibility plus the
 * server's granted permissions — never hard-coded per screen. Tools whose
 * permissions were not granted are excluded; note/artifact saves need no
 * special grant beyond a completed execution.
 */
export function sendToCandidates(
  outputType: ContextType,
  tools: readonly ToolDescriptor[],
  grantedPermissions: readonly string[],
): SendToCandidate[] {
  const granted = new Set(grantedPermissions);
  const candidates: SendToCandidate[] = [];
  if (SAVABLE_OUTPUT_TYPES.includes(outputType)) {
    candidates.push({
      kind: "note",
      label: "Save as Note",
      detail: "Save this output as a project note",
      requiresPermissions: [],
    });
    candidates.push({
      kind: "artifact",
      label: "Save as Artifact",
      detail: "Save this output as a project artifact",
      requiresPermissions: [],
    });
  }
  for (const tool of tools) {
    if (!tool.accepts.includes(outputType)) continue;
    if (!tool.permissions.every((value) => granted.has(value))) continue;
    candidates.push({
      kind: "tool",
      label: `Send to ${tool.name}`,
      detail: `${tool.id}@${tool.version} accepts ${outputType}`,
      toolId: tool.id,
      toolVersion: tool.version,
      requiresPermissions: [...tool.permissions],
    });
  }
  return candidates;
}

export interface TokenUsage {
  promptTokens?: unknown;
  completionTokens?: unknown;
  totalTokens?: unknown;
}

function tokenNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/** "9 tokens" for provider counts, "~9 tokens (estimated)" for estimates. */
export function formatTokenUsage(
  usage: TokenUsage,
  usageSource?: string,
): string {
  const total = tokenNumber(usage.totalTokens) ?? 0;
  return usageSource === "estimated"
    ? `~${total} tokens (estimated)`
    : `${total} tokens`;
}

export function usageSourceOf(output: {
  type: string;
  payload: unknown;
}): string | undefined {
  if (output.type !== "ai_response" && output.type !== "agent_response")
    return undefined;
  if (output.payload !== null && typeof output.payload === "object") {
    const source = (output.payload as { usageSource?: unknown }).usageSource;
    if (source === "provider" || source === "estimated") return source;
  }
  return undefined;
}
