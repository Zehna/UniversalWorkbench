import type {
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from "@uw/contracts";
import { createTextTrimTool, createToolRegistry } from "@uw/tools";
import { describe, expect, it } from "vitest";
import {
  topologicalOrder,
  validateWorkflow,
  WorkflowValidationError,
} from "../src/index.js";

const id = (n: number): string =>
  "00000000-0000-4000-8000-" + String(n).padStart(12, "0");

function node(n: number): WorkflowNode {
  return {
    id: id(n),
    toolId: "builtin.text.trim",
    toolVersion: "1.0.0",
    config: {},
    input: { source: "workflow_input" },
  };
}

function definition(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[] = [],
): WorkflowDefinition {
  return {
    id: id(100),
    projectId: id(101),
    name: "Graph test",
    schemaVersion: 1,
    nodes,
    edges,
  };
}

function expectCode(action: () => unknown, code: string): void {
  expect(action).toThrow(WorkflowValidationError);
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe("deterministic workflow DAG ordering", () => {
  it("orders disconnected nodes and tied dependencies by node ID, not input array position", () => {
    const edges = [{ from: id(1), to: id(3) }];
    const forward = definition([node(4), node(3), node(2), node(1)], edges);
    const reversed = definition(
      [node(2), node(1), node(3), node(4)],
      [...edges].reverse(),
    );

    expect(topologicalOrder(forward)).toEqual([id(1), id(2), id(3), id(4)]);
    expect(topologicalOrder(reversed)).toEqual(topologicalOrder(forward));
  });

  it("respects multiple incoming control edges and sorts each ready queue", () => {
    const graph = definition(
      [node(4), node(1), node(3), node(2)],
      [
        { from: id(1), to: id(4) },
        { from: id(2), to: id(4) },
        { from: id(3), to: id(4) },
      ],
    );
    expect(topologicalOrder(graph)).toEqual([id(1), id(2), id(3), id(4)]);
  });

  it("handles an empty graph without inventing a node", () => {
    expect(topologicalOrder(definition([]))).toEqual([]);
  });

  it("rejects directed cycles even when all referenced nodes exist", () => {
    const graph = definition(
      [node(1), node(2), node(3)],
      [
        { from: id(1), to: id(2) },
        { from: id(2), to: id(3) },
        { from: id(3), to: id(1) },
      ],
    );
    expectCode(() => topologicalOrder(graph), "CYCLE");
  });

  it("rejects explicit self-dependencies", () => {
    expectCode(
      () =>
        topologicalOrder(definition([node(1)], [{ from: id(1), to: id(1) }])),
      "SELF_EDGE",
    );
  });

  it("rejects both missing-source and missing-target edges", () => {
    expectCode(
      () =>
        topologicalOrder(definition([node(1)], [{ from: id(9), to: id(1) }])),
      "DANGLING_EDGE",
    );
    expectCode(
      () =>
        topologicalOrder(definition([node(1)], [{ from: id(1), to: id(9) }])),
      "DANGLING_EDGE",
    );
  });

  it("rejects duplicate edges rather than corrupting in-degree accounting", () => {
    const edge = { from: id(1), to: id(2) };
    expectCode(
      () => topologicalOrder(definition([node(1), node(2)], [edge, edge])),
      "DUPLICATE_EDGE",
    );
  });

  it("rejects duplicate node IDs through the public validator and graph function", () => {
    const graph = definition([node(1), node(1)]);
    expectCode(() => topologicalOrder(graph), "DUPLICATE_NODE");
    const registry = createToolRegistry();
    registry.register(createTextTrimTool());
    expectCode(() => validateWorkflow(graph, registry), "DUPLICATE_NODE");
  });

  it("rejects malformed runtime workflow objects at the contract boundary", () => {
    const registry = createToolRegistry();
    registry.register(createTextTrimTool());
    const malformed = {
      ...definition([node(1)]),
      schemaVersion: 99,
    } as unknown as WorkflowDefinition;
    expectCode(() => validateWorkflow(malformed, registry), "INVALID_WORKFLOW");
  });
});
