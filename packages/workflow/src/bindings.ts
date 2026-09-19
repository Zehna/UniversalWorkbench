import type { WorkflowEdge } from "@uw/contracts";
import { WorkflowBindingError } from "./errors.js";

export type NodeOutputValues = Record<string, Record<string, unknown>>;

export function bindNodeInputs(
  nodeId: string,
  edges: readonly WorkflowEdge[],
  outputs: NodeOutputValues,
): Record<string, unknown> {
  const bindings: Record<string, unknown> = {};

  for (const edge of edges) {
    if (edge.to.nodeId !== nodeId) continue;

    const upstream = outputs[edge.from.nodeId];
    if (
      upstream === undefined ||
      !Object.prototype.hasOwnProperty.call(upstream, edge.from.output)
    ) {
      throw new WorkflowBindingError(
        `Missing upstream output ${edge.from.nodeId}.${edge.from.output} for ${nodeId}.${edge.to.input}`,
      );
    }

    bindings[edge.to.input] = upstream[edge.from.output];
  }

  return bindings;
}
