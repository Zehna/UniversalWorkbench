import { describe, expect, it } from "vitest";
import type { WorkflowDefinitionV1 } from "@uw/contracts";
import { bindNodeInputs, buildWorkflowPlan } from "../src/index.js";

const branched: WorkflowDefinitionV1 = {
  schemaVersion: 1,
  name: "Branched",
  nodes: [
    { id: "root", tool: { id: "test.source", version: "1" }, config: {} },
    { id: "left", tool: { id: "test.json", version: "1" }, config: {} },
    { id: "right", tool: { id: "test.json", version: "1" }, config: {} },
    { id: "join", tool: { id: "test.json", version: "1" }, config: {} },
  ],
  edges: [
    {
      from: { nodeId: "root", output: "output" },
      to: { nodeId: "left", input: "input" },
    },
    {
      from: { nodeId: "root", output: "output" },
      to: { nodeId: "right", input: "input" },
    },
    {
      from: { nodeId: "left", output: "output" },
      to: { nodeId: "join", input: "left" },
    },
    {
      from: { nodeId: "right", output: "output" },
      to: { nodeId: "join", input: "right" },
    },
  ],
  outputs: [{ name: "result", from: { nodeId: "join", output: "output" } }],
};

describe("workflow planning", () => {
  it("builds deterministic roots, terminals, dependencies and topological order", () => {
    expect(buildWorkflowPlan(branched)).toEqual({
      order: ["root", "left", "right", "join"],
      roots: ["root"],
      terminals: ["join"],
      dependencies: {
        root: [],
        left: ["root"],
        right: ["root"],
        join: ["left", "right"],
      },
      dependents: {
        root: ["left", "right"],
        left: ["join"],
        right: ["join"],
        join: [],
      },
    });
  });

  it("binds upstream outputs to the target input names", () => {
    const bound = bindNodeInputs("join", branched.edges, {
      left: { output: "LEFT" },
      right: { output: "RIGHT" },
    });

    expect(bound).toEqual({ left: "LEFT", right: "RIGHT" });
  });

  it("fails closed when a required upstream output is absent", () => {
    expect(() =>
      bindNodeInputs("join", branched.edges, {
        left: { output: "LEFT" },
      }),
    ).toThrow(/missing upstream output/i);
  });
});
