import type {
  ContextType,
  ToolDescriptor,
  WorkflowDefinition,
  WorkflowNode,
} from "@uw/contracts";
import {
  createTextTrimTool,
  createToolRegistry,
  type ToolRegistry,
} from "@uw/tools";
import { describe, expect, it } from "vitest";
import {
  buildPreflightPlan,
  validateWorkflow,
  WorkflowValidationError,
} from "../src/index.js";

const id = (n: number): string =>
  "00000000-0000-4000-8000-" + String(n).padStart(12, "0");

function registryWith(
  ...tools: Array<{
    id: string;
    version?: string;
    accepts?: ContextType[];
    produces?: ContextType[];
    permissions?: string[];
    capabilities?: string[];
    idempotency?: ToolDescriptor["idempotency"];
  }>
): ToolRegistry {
  const registry = createToolRegistry();
  for (const tool of tools) {
    const executor = createTextTrimTool();
    executor.descriptor = {
      ...executor.descriptor,
      id: tool.id,
      version: tool.version ?? "1.0.0",
      accepts: tool.accepts ?? ["text"],
      produces: tool.produces ?? ["text"],
      permissions: tool.permissions ?? [],
      capabilities: tool.capabilities ?? [],
      idempotency: tool.idempotency ?? "safe",
    };
    registry.register(executor);
  }
  return registry;
}

function node(
  n: number,
  toolId: string,
  input: WorkflowNode["input"] = { source: "workflow_input" },
  overrides: Partial<WorkflowNode> = {},
): WorkflowNode {
  return {
    id: id(n),
    toolId,
    toolVersion: "1.0.0",
    config: {},
    input,
    ...overrides,
  };
}

function workflow(
  nodes: WorkflowNode[],
  edges: WorkflowDefinition["edges"] = [],
): WorkflowDefinition {
  return {
    id: id(100),
    projectId: id(101),
    name: "Preflight fixture",
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

describe("typed bindings and pinned tool versions", () => {
  it("validates a producer's declared output index and the consumer's accepted type", () => {
    const registry = registryWith(
      { id: "test.producer", produces: ["json", "text"] },
      { id: "test.consumer", accepts: ["text"] },
    );
    const source = node(1, "test.producer");
    const consumer = node(2, "test.consumer", {
      source: "node_output",
      nodeId: id(1),
      outputIndex: 1,
    });
    const validated = validateWorkflow(
      workflow([consumer, source], [{ from: id(1), to: id(2) }]),
      registry,
    );
    expect(validated.orderedNodeIds).toEqual([id(1), id(2)]);
    expect(validated.inputTypes.get(id(1))).toBeNull();
    expect(validated.inputTypes.get(id(2))).toBe("text");
    expect(validated.descriptors.get(id(2))?.id).toBe("test.consumer");
  });

  it("rejects incompatible output-to-input context bindings", () => {
    const registry = registryWith(
      { id: "test.producer", produces: ["text"] },
      { id: "test.consumer", accepts: ["json"] },
    );
    const graph = workflow(
      [
        node(1, "test.producer"),
        node(2, "test.consumer", {
          source: "node_output",
          nodeId: id(1),
          outputIndex: 0,
        }),
      ],
      [{ from: id(1), to: id(2) }],
    );
    expectCode(() => validateWorkflow(graph, registry), "INCOMPATIBLE_CONTEXT");
  });

  it("rejects out-of-range output indexes", () => {
    const registry = registryWith(
      { id: "test.producer", produces: ["json"] },
      {
        id: "test.consumer",
        accepts: ["json"],
      },
    );
    const graph = workflow(
      [
        node(1, "test.producer"),
        node(2, "test.consumer", {
          source: "node_output",
          nodeId: id(1),
          outputIndex: 1,
        }),
      ],
      [{ from: id(1), to: id(2) }],
    );
    expectCode(() => validateWorkflow(graph, registry), "INVALID_OUTPUT_INDEX");
  });

  it("rejects bindings to missing sources even if the edge list is empty", () => {
    const registry = registryWith({ id: "test.consumer" });
    const graph = workflow([
      node(2, "test.consumer", {
        source: "node_output",
        nodeId: id(99),
        outputIndex: 0,
      }),
    ]);
    expectCode(() => validateWorkflow(graph, registry), "MISSING_SOURCE");
  });

  it("requires explicit dependency edges for node-output bindings", () => {
    const registry = registryWith(
      { id: "test.producer" },
      { id: "test.consumer" },
    );
    const graph = workflow([
      node(1, "test.producer"),
      node(2, "test.consumer", {
        source: "node_output",
        nodeId: id(1),
        outputIndex: 0,
      }),
    ]);
    expectCode(() => validateWorkflow(graph, registry), "MISSING_DEPENDENCY");
  });

  it("rejects self-referential bindings without a graph edge", () => {
    const registry = registryWith({ id: "test.consumer" });
    const graph = workflow([
      node(1, "test.consumer", {
        source: "node_output",
        nodeId: id(1),
        outputIndex: 0,
      }),
    ]);
    expectCode(() => validateWorkflow(graph, registry), "SELF_EDGE");
  });

  it("resolves only exact pinned tool versions with no latest or range fallback", () => {
    const registry = registryWith({ id: "test.versioned", version: "1.0.0" });
    const graph = workflow([node(1, "test.versioned")]);
    expect(
      validateWorkflow(graph, registry).descriptors.get(id(1))?.version,
    ).toBe("1.0.0");
    expectCode(
      () =>
        validateWorkflow(
          workflow([
            node(1, "test.versioned", undefined, { toolVersion: "2.0.0" }),
          ]),
          registry,
        ),
      "TOOL_NOT_FOUND",
    );
    expectCode(
      () =>
        validateWorkflow(
          workflow([
            node(1, "test.versioned", undefined, { toolVersion: "^1.0.0" }),
          ]),
          registry,
        ),
      "TOOL_NOT_FOUND",
    );
  });
});

describe("permission and network preflight", () => {
  it("rejects missing permissions before creating an execution plan", () => {
    const registry = registryWith({
      id: "test.network",
      permissions: ["read:private", "network"],
      capabilities: ["network"],
    });
    const validated = validateWorkflow(
      workflow([node(1, "test.network")]),
      registry,
    );
    expectCode(
      () => buildPreflightPlan(validated, new Set(["network"])),
      "MISSING_PERMISSION",
    );
    const plan = buildPreflightPlan(
      validated,
      new Set(["network", "read:private"]),
    );
    expect(plan.orderedNodeIds).toEqual([id(1)]);
    expect(plan.requiredPermissions).toEqual(["network", "read:private"]);
    expect(plan.requiresNetwork).toBe(true);
    expect(plan.warnings).toEqual([
      "Workflow input context types must be checked at execution for nodes: " +
        id(1),
    ]);
  });

  it("detects network capability even if its permission is named differently", () => {
    const registry = registryWith({
      id: "test.capability",
      capabilities: ["network"],
      permissions: ["egress:approved"],
    });
    const validated = validateWorkflow(
      workflow([node(1, "test.capability")]),
      registry,
    );
    const plan = buildPreflightPlan(validated, new Set(["egress:approved"]));
    expect(plan.requiresNetwork).toBe(true);
    expect(plan.requiredPermissions).toEqual(["egress:approved"]);
  });

  it("keeps disconnected workflow planning deterministic and does not mutate the input", () => {
    const registry = registryWith({ id: "test.text" });
    const graph = workflow([
      node(3, "test.text"),
      node(1, "test.text"),
      node(2, "test.text"),
    ]);
    const original = JSON.stringify(graph);
    const validated = validateWorkflow(graph, registry);
    const plan = buildPreflightPlan(validated, new Set());
    expect(plan.orderedNodeIds).toEqual([id(1), id(2), id(3)]);
    expect(plan.requiredPermissions).toEqual([]);
    expect(plan.requiresNetwork).toBe(false);
    expect(plan.warnings).toHaveLength(1);
    expect(JSON.stringify(graph)).toBe(original);
  });

  it("refuses unsafe retries without a workflow idempotency key", () => {
    const registry = registryWith({ id: "test.unsafe", idempotency: "unsafe" });
    const unsafe = node(1, "test.unsafe", undefined, {
      retry: { maxAttempts: 3, backoffMs: 100 },
    });
    expectCode(
      () => validateWorkflow(workflow([unsafe]), registry),
      "UNSAFE_RETRY",
    );
    const pinned = { ...unsafe, idempotencyKey: "operation-1" };
    expect(
      validateWorkflow(workflow([pinned]), registry).orderedNodeIds,
    ).toEqual([id(1)]);
  });

  it("allows HTTP GET without a key but requires one for POST and its retries", () => {
    const registry = registryWith({
      id: "builtin.http.request",
      accepts: ["json", "text", "markdown"],
      produces: ["api_response"],
      permissions: ["network"],
      capabilities: ["network"],
      idempotency: "unsafe",
    });
    const get = node(1, "builtin.http.request", undefined, {
      config: { method: "GET", url: "https://example.com" },
      retry: { maxAttempts: 3, backoffMs: 1 },
    });
    expect(validateWorkflow(workflow([get]), registry).orderedNodeIds).toEqual([
      id(1),
    ]);
    const post = node(1, "builtin.http.request", undefined, {
      config: { method: "POST", url: "https://example.com" },
    });
    expectCode(
      () => validateWorkflow(workflow([post]), registry),
      "MISSING_IDEMPOTENCY_KEY",
    );
    expect(
      validateWorkflow(
        workflow([{ ...post, idempotencyKey: "workflow-operation" }]),
        registry,
      ).orderedNodeIds,
    ).toEqual([id(1)]);
  });

  it("does not grant network access merely because input data requests it", () => {
    const registry = registryWith({
      id: "test.network",
      permissions: ["network"],
    });
    const validated = validateWorkflow(
      workflow([node(1, "test.network")]),
      registry,
    );
    expectCode(
      () => buildPreflightPlan(validated, new Set()),
      "MISSING_PERMISSION",
    );
  });
});
