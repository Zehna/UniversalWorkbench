import type {
  ExecutionBudget,
  ToolCapability,
  ToolDefinition,
  WorkflowDefinitionV1,
  WorkflowNode,
} from "@uw/contracts";
import { ToolNotFoundError, ToolRegistry } from "@uw/tools";
import type {
  WorkflowValidationError,
} from "./errors.js";
import type { WorkflowValidationResult } from "./model.js";
import { buildWorkflowPlan } from "./planner.js";

function error(
  code: WorkflowValidationError["code"],
  message: string,
  nodeId?: string,
): WorkflowValidationError {
  return nodeId === undefined ? { code, message } : { code, message, nodeId };
}

function resolveNodes(
  definition: WorkflowDefinitionV1,
  registry: ToolRegistry,
  errors: WorkflowValidationError[],
): Map<string, ToolDefinition> {
  const resolved = new Map<string, ToolDefinition>();

  for (const node of definition.nodes) {
    try {
      resolved.set(
        node.id,
        registry.resolve(node.tool.id, node.tool.version).definition,
      );
    } catch (cause) {
      if (cause instanceof ToolNotFoundError) {
        errors.push(
          error(
            "UNKNOWN_TOOL",
            `Tool ${node.tool.id}@${node.tool.version} is not registered`,
            node.id,
          ),
        );
        continue;
      }
      throw cause;
    }
  }

  return resolved;
}

function findNode(
  definition: WorkflowDefinitionV1,
  nodeId: string,
): WorkflowNode | undefined {
  return definition.nodes.find((node) => node.id === nodeId);
}

export function validateWorkflowDefinition(
  definition: WorkflowDefinitionV1,
  registry: ToolRegistry,
  allowedCapabilities: Iterable<ToolCapability>,
  budget: ExecutionBudget,
): WorkflowValidationResult {
  const errors: WorkflowValidationError[] = [];
  const seenNodeIds = new Set<string>();
  const duplicateNodeIds = new Set<string>();

  for (const node of definition.nodes) {
    if (seenNodeIds.has(node.id)) {
      duplicateNodeIds.add(node.id);
      errors.push(
        error("DUPLICATE_NODE", `Duplicate workflow node ${node.id}`, node.id),
      );
    }
    seenNodeIds.add(node.id);
  }

  if (definition.nodes.length > budget.maxSteps) {
    errors.push(
      error(
        "BUDGET_EXCEEDED",
        `Workflow has ${definition.nodes.length} steps but budget allows ${budget.maxSteps}`,
      ),
    );
  }

  const resolved = resolveNodes(definition, registry, errors);
  const granted = new Set(allowedCapabilities);

  for (const node of definition.nodes) {
    const tool = resolved.get(node.id);
    if (!tool) continue;

    for (const capability of tool.requiredCapabilities) {
      if (!granted.has(capability)) {
        errors.push(
          error(
            "CAPABILITY_DENIED",
            `Tool ${tool.id}@${tool.version} requires ${capability}`,
            node.id,
          ),
        );
      }
    }
  }

  for (const edge of definition.edges) {
    const sourceNode = findNode(definition, edge.from.nodeId);
    const targetNode = findNode(definition, edge.to.nodeId);
    const sourceTool = sourceNode ? resolved.get(sourceNode.id) : undefined;
    const targetTool = targetNode ? resolved.get(targetNode.id) : undefined;

    if (!sourceNode || !targetNode || !sourceTool || !targetTool) {
      errors.push(
        error(
          "UNKNOWN_PORT",
          `Edge references an unknown node or unresolved tool: ${edge.from.nodeId} -> ${edge.to.nodeId}`,
        ),
      );
      continue;
    }

    const sourcePort = sourceTool.produces.find(
      (port) => port.name === edge.from.output,
    );
    const targetPort = targetTool.accepts.find(
      (port) => port.name === edge.to.input,
    );

    if (!sourcePort || !targetPort) {
      errors.push(
        error(
          "UNKNOWN_PORT",
          `Edge references an unknown port: ${edge.from.nodeId}.${edge.from.output} -> ${edge.to.nodeId}.${edge.to.input}`,
          !sourcePort ? sourceNode.id : targetNode.id,
        ),
      );
      continue;
    }

    const compatible = sourcePort.types.some((sourceType) =>
      registry.compatibility.accepts(targetPort, sourceType),
    );
    if (!compatible) {
      errors.push(
        error(
          "TYPE_MISMATCH",
          `Output ${edge.from.nodeId}.${edge.from.output} is incompatible with ${edge.to.nodeId}.${edge.to.input}`,
          targetNode.id,
        ),
      );
    }
  }

  for (const node of definition.nodes) {
    const tool = resolved.get(node.id);
    if (!tool) continue;

    for (const input of tool.accepts) {
      if (!input.required) continue;
      const isBound = definition.edges.some(
        (edge) => edge.to.nodeId === node.id && edge.to.input === input.name,
      );
      if (!isBound) {
        errors.push(
          error(
            "MISSING_INPUT",
            `Required input ${node.id}.${input.name} is not bound`,
            node.id,
          ),
        );
      }
    }
  }

  for (const output of definition.outputs) {
    const node = findNode(definition, output.from.nodeId);
    const tool = node ? resolved.get(node.id) : undefined;
    const port = tool?.produces.find(
      (candidate) => candidate.name === output.from.output,
    );
    if (!node || !tool || !port) {
      errors.push(
        error(
          "UNKNOWN_PORT",
          `Workflow output ${output.name} references an unknown output port`,
          output.from.nodeId,
        ),
      );
    }
  }

  if (definition.outputs.length === 0) {
    errors.push(
      error(
        "NO_TERMINAL",
        "Workflow must declare at least one terminal output",
      ),
    );
  }

  if (duplicateNodeIds.size === 0) {
    const plan = buildWorkflowPlan(definition);
    if (plan.order.length !== definition.nodes.length) {
      errors.push(error("WORKFLOW_CYCLE", "Workflow graph contains a cycle"));
    }
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}
