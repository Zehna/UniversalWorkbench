import { describe, expect, it } from "vitest";
import type {
  ExecutionBudget,
  ToolCapability,
  ToolDefinition,
  WorkflowDefinitionV1,
} from "@uw/contracts";
import { ToolRegistry, type ToolRunner } from "@uw/tools";
import { validateWorkflowDefinition } from "../src/validate.js";

const runner: ToolRunner = {
  async run() {
    return { outputs: {}, usage: { outputBytes: 0, httpRequests: 0 } };
  },
};

function tool(
  id: string,
  options: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    id,
    version: "1",
    displayName: id,
    description: id,
    executionMode: "worker",
    accepts: [{ name: "input", types: ["json"], required: true }],
    produces: [{ name: "output", types: ["json"] }],
    configSchema: {},
    requiredCapabilities: [],
    defaults: { timeoutMs: 5000, maxAttempts: 1 },
    ...options,
  };
}

function registry(): ToolRegistry {
  const value = new ToolRegistry();
  value.register(tool("test.source", { accepts: [] }), runner);
  value.register(
    tool("test.configured", {
      configSchema: {
        type: "object",
        required: ["pointer"],
        additionalProperties: false,
        properties: { pointer: { type: "string" } },
      },
    }),
    runner,
  );
  value.register(tool("test.json"), runner);
  value.register(
    tool("test.text", {
      accepts: [{ name: "input", types: ["text"], required: true }],
      produces: [{ name: "output", types: ["text"] }],
    }),
    runner,
  );
  value.register(
    tool("test.network", {
      requiredCapabilities: ["network.public"],
    }),
    runner,
  );
  return value;
}

const budget: ExecutionBudget = {
  maxWallClockMs: 60_000,
  maxSteps: 10,
  maxAttemptsPerStep: 3,
  maxTotalAttempts: 20,
  maxOutputBytes: 1_048_576,
  maxHttpRequests: 10,
};

function validWorkflow(): WorkflowDefinitionV1 {
  return {
    schemaVersion: 1,
    name: "Valid",
    nodes: [
      { id: "source", tool: { id: "test.source", version: "1" }, config: {} },
      { id: "select", tool: { id: "test.json", version: "1" }, config: {} },
    ],
    edges: [
      {
        from: { nodeId: "source", output: "output" },
        to: { nodeId: "select", input: "input" },
      },
    ],
    outputs: [{ name: "result", from: { nodeId: "select", output: "output" } }],
  };
}

function codes(
  definition: WorkflowDefinitionV1,
  allowed: ToolCapability[] = [],
): string[] {
  const result = validateWorkflowDefinition(
    definition,
    registry(),
    allowed,
    budget,
  );
  return result.ok ? [] : result.errors.map((error) => error.code);
}

describe("validateWorkflowDefinition", () => {
  it("accepts a valid typed workflow", () => {
    expect(
      validateWorkflowDefinition(validWorkflow(), registry(), [], budget),
    ).toEqual({ ok: true, errors: [] });
  });

  it("rejects duplicate node ids", () => {
    const definition = validWorkflow();
    definition.nodes.push({
      id: "source",
      tool: { id: "test.source", version: "1" },
      config: {},
    });
    expect(codes(definition)).toContain("DUPLICATE_NODE");
  });

  it("rejects an unknown pinned tool version", () => {
    const definition = validWorkflow();
    definition.nodes[0]!.tool.version = "99";
    expect(codes(definition)).toContain("UNKNOWN_TOOL");
  });

  it("rejects missing edge ports", () => {
    const definition = validWorkflow();
    definition.edges[0]!.from.output = "missing";
    expect(codes(definition)).toContain("UNKNOWN_PORT");
  });

  it("rejects incompatible context bindings", () => {
    const definition = validWorkflow();
    definition.nodes[1]!.tool = { id: "test.text", version: "1" };
    expect(codes(definition)).toContain("TYPE_MISMATCH");
  });

  it("rejects multiple bindings to the same input port", () => {
    const definition = validWorkflow();
    definition.nodes.push({
      id: "source-2",
      tool: { id: "test.source", version: "1" },
      config: {},
    });
    definition.edges.push({
      from: { nodeId: "source-2", output: "output" },
      to: { nodeId: "select", input: "input" },
    });

    expect(codes(definition)).toContain("MULTIPLE_INPUT");
  });

  it("rejects a required input with no binding", () => {
    const definition = validWorkflow();
    definition.edges = [];
    expect(codes(definition)).toContain("MISSING_INPUT");
  });

  it("rejects a self-loop", () => {
    const definition = validWorkflow();
    definition.edges.push({
      from: { nodeId: "select", output: "output" },
      to: { nodeId: "select", input: "input" },
    });
    expect(codes(definition)).toContain("WORKFLOW_CYCLE");
  });

  it("rejects a multi-node cycle even when every port type is compatible", () => {
    const definition: WorkflowDefinitionV1 = {
      schemaVersion: 1,
      name: "Cycle",
      nodes: [
        { id: "a", tool: { id: "test.json", version: "1" }, config: {} },
        { id: "b", tool: { id: "test.json", version: "1" }, config: {} },
      ],
      edges: [
        {
          from: { nodeId: "a", output: "output" },
          to: { nodeId: "b", input: "input" },
        },
        {
          from: { nodeId: "b", output: "output" },
          to: { nodeId: "a", input: "input" },
        },
      ],
      outputs: [{ name: "result", from: { nodeId: "b", output: "output" } }],
    };

    expect(codes(definition)).toContain("WORKFLOW_CYCLE");
  });

  it("rejects a workflow without a declared terminal output", () => {
    const definition = validWorkflow();
    definition.outputs = [];
    expect(codes(definition)).toContain("NO_TERMINAL");
  });

  it("rejects string configuration outside declared length constraints", () => {
    const value = registry();
    value.register(
      tool("test.titled", {
        accepts: [],
        configSchema: {
          type: "object",
          required: ["title"],
          additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1, maxLength: 4 },
          },
        },
      }),
      runner,
    );
    const definition: WorkflowDefinitionV1 = {
      schemaVersion: 1,
      name: "Invalid title",
      nodes: [
        {
          id: "title",
          tool: { id: "test.titled", version: "1" },
          config: { title: "" },
        },
      ],
      edges: [],
      outputs: [{ name: "result", from: { nodeId: "title", output: "output" } }],
    };

    const result = validateWorkflowDefinition(definition, value, [], budget);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: "INVALID_CONFIG", nodeId: "title" }),
      );
    }
  });

  it("rejects tool configuration that does not match the pinned schema", () => {
    const definition = validWorkflow();
    definition.nodes[1]!.tool = { id: "test.configured", version: "1" };
    definition.nodes[1]!.config = { extra: true };

    expect(codes(definition)).toContain("INVALID_CONFIG");
  });

  it("rejects unavailable capabilities", () => {
    const definition = validWorkflow();
    definition.nodes[1]!.tool = { id: "test.network", version: "1" };
    expect(codes(definition)).toContain("CAPABILITY_DENIED");
  });

  it("accepts capabilities granted by preflight", () => {
    const definition = validWorkflow();
    definition.nodes[1]!.tool = { id: "test.network", version: "1" };
    expect(codes(definition, ["network.public"])).not.toContain(
      "CAPABILITY_DENIED",
    );
  });

  it("rejects workflows whose static step count exceeds budget", () => {
    const definition = validWorkflow();
    const tinyBudget = { ...budget, maxSteps: 1 };
    const result = validateWorkflowDefinition(
      definition,
      registry(),
      [],
      tinyBudget,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: "BUDGET_EXCEEDED" }),
      );
    }
  });
});
