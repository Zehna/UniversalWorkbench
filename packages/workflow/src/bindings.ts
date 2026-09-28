import type {
  ContextType,
  ToolDescriptor,
  WorkflowDefinition,
} from "@uw/contracts";
import { WorkflowValidationError } from "./errors.js";

/**
 * Validate only statically-known node-output context types. The workflow
 * contract has no workflow_input type, so root input types are verified at
 * execution time; never guess a type or grant permissions from its payload.
 */
export function validateBindings(
  workflow: WorkflowDefinition,
  descriptors: ReadonlyMap<string, ToolDescriptor>,
): ReadonlyMap<string, ContextType | null> {
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  const edges = new Set(
    workflow.edges.map((edge) => edge.from + ":" + edge.to),
  );
  const inputTypes = new Map<string, ContextType | null>();

  for (const node of workflow.nodes) {
    if (node.input.source === "workflow_input") {
      inputTypes.set(node.id, null);
      continue;
    }

    const binding = node.input;
    const producer = nodes.get(binding.nodeId);
    if (!producer) {
      throw new WorkflowValidationError(
        "MISSING_SOURCE",
        "Node output binding refers to an unknown source node",
      );
    }
    if (producer.id === node.id) {
      throw new WorkflowValidationError(
        "SELF_EDGE",
        "A node cannot consume its own output",
      );
    }
    if (!edges.has(producer.id + ":" + node.id)) {
      throw new WorkflowValidationError(
        "MISSING_DEPENDENCY",
        "A node output binding requires an explicit dependency edge",
      );
    }

    const sourceDescriptor = descriptors.get(producer.id)!;
    const targetDescriptor = descriptors.get(node.id)!;
    const producedType = sourceDescriptor.produces[binding.outputIndex];
    if (producedType === undefined) {
      throw new WorkflowValidationError(
        "INVALID_OUTPUT_INDEX",
        "Node output binding index exceeds the producer's declared outputs",
      );
    }
    if (!targetDescriptor.accepts.includes(producedType)) {
      throw new WorkflowValidationError(
        "INCOMPATIBLE_CONTEXT",
        "Node output context type is not accepted by the target tool",
      );
    }
    inputTypes.set(node.id, producedType);
  }

  return inputTypes;
}
