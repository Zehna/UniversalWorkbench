import type {
  ContextEnvelope,
  ContextType,
  ToolDescriptor,
} from "@uw/contracts";
import { isToolCompatible } from "./compatibility.js";

export interface ContextCandidate {
  toolId: string;
  toolVersion: string;
  acceptedType: ContextType;
}

export interface ContextBus {
  compatibleTools(
    context: ContextEnvelope,
    tools: readonly ToolDescriptor[],
    grantedPermissions: ReadonlySet<string>,
  ): ContextCandidate[];
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function createContextBus(): ContextBus {
  return {
    compatibleTools(context, tools, grantedPermissions) {
      return tools
        .filter((tool) => isToolCompatible(context, tool, grantedPermissions))
        .map((tool): ContextCandidate => ({
          toolId: tool.id,
          toolVersion: tool.version,
          acceptedType: context.type,
        }))
        .sort(
          (left, right) =>
            compareStrings(left.toolId, right.toolId) ||
            compareStrings(left.toolVersion, right.toolVersion),
        );
    },
  };
}
