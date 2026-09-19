import type { WorkflowDefinitionV1 } from "@uw/contracts";
import type { WorkflowPlan } from "./model.js";

export function buildWorkflowPlan(
  definition: WorkflowDefinitionV1,
): WorkflowPlan {
  const nodeIds = definition.nodes.map((node) => node.id);
  const nodeSet = new Set(nodeIds);
  const dependencies: Record<string, string[]> = {};
  const dependents: Record<string, string[]> = {};
  const indegree = new Map<string, number>();

  for (const nodeId of nodeIds) {
    dependencies[nodeId] = [];
    dependents[nodeId] = [];
    indegree.set(nodeId, 0);
  }

  for (const edge of definition.edges) {
    if (!nodeSet.has(edge.from.nodeId) || !nodeSet.has(edge.to.nodeId)) {
      continue;
    }

    dependencies[edge.to.nodeId]!.push(edge.from.nodeId);
    dependents[edge.from.nodeId]!.push(edge.to.nodeId);
    indegree.set(edge.to.nodeId, (indegree.get(edge.to.nodeId) ?? 0) + 1);
  }

  const ready = nodeIds.filter((nodeId) => indegree.get(nodeId) === 0);
  const order: string[] = [];

  while (ready.length > 0) {
    const nodeId = ready.shift()!;
    order.push(nodeId);

    for (const dependent of dependents[nodeId] ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
      }
    }
  }

  return {
    order,
    roots: nodeIds.filter(
      (nodeId) => (dependencies[nodeId]?.length ?? 0) === 0,
    ),
    terminals: nodeIds.filter(
      (nodeId) => (dependents[nodeId]?.length ?? 0) === 0,
    ),
    dependencies,
    dependents,
  };
}
