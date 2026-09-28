import type { WorkflowDefinition } from "@uw/contracts";
import { WorkflowValidationError } from "./errors.js";

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Deterministic Kahn topological sort. Edges include control dependencies;
 * node-output bindings are verified independently in bindings.ts.
 */
export function topologicalOrder(workflow: WorkflowDefinition): string[] {
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, Set<string>>();
  for (const node of workflow.nodes) {
    if (indegree.has(node.id)) {
      throw new WorkflowValidationError(
        "DUPLICATE_NODE",
        "Workflow node IDs must be unique",
      );
    }
    indegree.set(node.id, 0);
    outgoing.set(node.id, new Set());
  }

  for (const edge of workflow.edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) {
      throw new WorkflowValidationError(
        "DANGLING_EDGE",
        "Workflow edges must reference existing nodes",
      );
    }
    if (edge.from === edge.to) {
      throw new WorkflowValidationError(
        "SELF_EDGE",
        "A node cannot depend on itself",
      );
    }
    const neighbors = outgoing.get(edge.from)!;
    if (neighbors.has(edge.to)) {
      throw new WorkflowValidationError(
        "DUPLICATE_EDGE",
        "Workflow contains a duplicate edge",
      );
    }
    neighbors.add(edge.to);
    indegree.set(edge.to, indegree.get(edge.to)! + 1);
  }

  const ready = [...indegree.keys()]
    .filter((id) => indegree.get(id) === 0)
    .sort(compareIds);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const current = ready.shift()!;
    ordered.push(current);
    const neighbors = [...outgoing.get(current)!].sort(compareIds);
    for (const next of neighbors) {
      const degree = indegree.get(next)! - 1;
      indegree.set(next, degree);
      if (degree === 0) {
        ready.push(next);
        ready.sort(compareIds);
      }
    }
  }

  if (ordered.length !== indegree.size) {
    throw new WorkflowValidationError(
      "CYCLE",
      "Workflow contains a dependency cycle",
    );
  }
  return ordered;
}
