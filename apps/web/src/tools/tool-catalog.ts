import type {
  ContextType,
  ToolDescriptor,
  WorkflowDefinition,
  WorkflowNode,
} from "@uw/contracts";

export function compatibleTools(
  tools: readonly ToolDescriptor[],
  rootType: ContextType,
  previous?: ToolDescriptor,
): ToolDescriptor[] {
  const inputs: readonly ContextType[] = previous
    ? previous.produces
    : [rootType];
  return tools.filter((tool) =>
    tool.accepts.some((accepted) => inputs.includes(accepted)),
  );
}

export function descriptorFor(
  tools: readonly ToolDescriptor[],
  node: WorkflowNode,
): ToolDescriptor | undefined {
  return tools.find(
    (tool) => tool.id === node.toolId && tool.version === node.toolVersion,
  );
}

export function isLinearWorkflow(definition: WorkflowDefinition): boolean {
  if (definition.edges.length !== Math.max(0, definition.nodes.length - 1))
    return false;
  return definition.nodes.every((node, index) => {
    if (index === 0) return node.input.source === "workflow_input";
    const prior = definition.nodes[index - 1]!;
    return (
      node.input.source === "node_output" &&
      node.input.nodeId === prior.id &&
      node.input.outputIndex === 0 &&
      definition.edges.some(
        (edge) => edge.from === prior.id && edge.to === node.id,
      )
    );
  });
}

export function linearDefinition(
  definition: WorkflowDefinition,
  nodes: readonly WorkflowNode[],
): WorkflowDefinition {
  return {
    ...definition,
    nodes: nodes.map((node, index) => ({
      ...node,
      input:
        index === 0
          ? { source: "workflow_input" as const }
          : {
              source: "node_output" as const,
              nodeId: nodes[index - 1]!.id,
              outputIndex: 0,
            },
    })),
    edges: nodes.slice(1).map((node, index) => ({
      from: nodes[index]!.id,
      to: node.id,
    })),
  };
}

export function linearTypesCompatible(
  nodes: readonly WorkflowNode[],
  tools: readonly ToolDescriptor[],
  rootType: ContextType,
): boolean {
  return nodes.every((node, index) => {
    const tool = descriptorFor(tools, node);
    if (!tool) return false;
    if (index === 0) return tool.accepts.includes(rootType);
    const prior = descriptorFor(tools, nodes[index - 1]!);
    return (
      !!prior && prior.produces.some((type) => tool.accepts.includes(type))
    );
  });
}

export function requiredPermissions(
  nodes: readonly WorkflowNode[],
  tools: readonly ToolDescriptor[],
): string[] {
  const needed = new Set<string>();
  for (const node of nodes) {
    descriptorFor(tools, node)?.permissions.forEach((value) =>
      needed.add(value),
    );
  }
  return [...needed].sort();
}

export function initialConfig(tool: ToolDescriptor): Record<string, unknown> {
  switch (tool.id) {
    case "builtin.http.request":
      return { method: "GET", url: "" };
    case "builtin.json.extract":
      return { path: "" };
    case "builtin.ai.complete":
      return {
        providerId: "mock",
        model: "",
        prompt: "",
        secretRef: "secret://vault/",
        responseFormat: { kind: "text" },
        maxOutputTokens: 1024,
      };
    default:
      return {};
  }
}
