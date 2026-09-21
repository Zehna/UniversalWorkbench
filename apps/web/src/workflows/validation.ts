import {
  validateToolConfig,
  type ToolDefinition,
  type WorkflowDefinitionV1,
} from "@uw/contracts";

export function validateLinearWorkflowDraft(
  definition: WorkflowDefinitionV1,
  tools: ToolDefinition[],
): string[] {
  const issues: string[] = [];
  const toolByNode = new Map<string, ToolDefinition>();

  for (const node of definition.nodes) {
    const tool = tools.find(
      (candidate) =>
        candidate.id === node.tool.id &&
        candidate.version === node.tool.version,
    );
    if (!tool) {
      issues.push(`Unknown tool ${node.tool.id}@${node.tool.version}`);
      continue;
    }
    toolByNode.set(node.id, tool);

    const config = validateToolConfig(tool, node.config);
    if (!config.ok) {
      issues.push(
        ...config.issues.map(
          (issue) =>
            `${node.id} config ${issue.path}: ${issue.message}`,
        ),
      );
    }
  }

  for (const edge of definition.edges) {
    const source = toolByNode.get(edge.from.nodeId);
    const target = toolByNode.get(edge.to.nodeId);
    const output = source?.produces.find(
      (port) => port.name === edge.from.output,
    );
    const input = target?.accepts.find((port) => port.name === edge.to.input);

    if (!source || !target || !output || !input) {
      issues.push(
        `Invalid binding ${edge.from.nodeId}.${edge.from.output} -> ${edge.to.nodeId}.${edge.to.input}`,
      );
      continue;
    }

    if (
      !output.types.some((type) => input.types.includes(type))
    ) {
      issues.push(
        `Incompatible binding ${edge.from.nodeId}.${edge.from.output} -> ${edge.to.nodeId}.${edge.to.input}`,
      );
    }
  }

  for (const node of definition.nodes) {
    const tool = toolByNode.get(node.id);
    if (!tool) continue;

    for (const input of tool.accepts) {
      if (
        input.required &&
        !definition.edges.some(
          (edge) =>
            edge.to.nodeId === node.id && edge.to.input === input.name,
        )
      ) {
        issues.push(`Required input ${node.id}.${input.name} is not bound`);
      }
    }
  }

  if (definition.outputs.length === 0) {
    issues.push("Workflow must declare a terminal output");
  } else {
    for (const output of definition.outputs) {
      const tool = toolByNode.get(output.from.nodeId);
      if (
        !tool?.produces.some((port) => port.name === output.from.output)
      ) {
        issues.push(
          `Workflow output ${output.name} references an unknown port`,
        );
      }
    }
  }

  return issues;
}
