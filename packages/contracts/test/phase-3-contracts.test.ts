import { describe, expect, it } from "vitest";
import {
  ContextEnvelopeSchema,
  ExecutionBudgetSchema,
  ToolDefinitionSchema,
  WorkflowDefinitionV1Schema,
} from "../src/index.js";

describe("Phase 3 contracts", () => {
  it("accepts a versioned json context envelope", () => {
    expect(
      ContextEnvelopeSchema.parse({
        id: "11111111-1111-4111-8111-111111111111",
        type: "json",
        schemaVersion: 1,
        mimeType: "application/json",
        metadata: {},
        payload: { ok: true },
        provenance: {
          projectId: "22222222-2222-4222-8222-222222222222",
          artifactIds: [],
          parentContextIds: [],
        },
        capabilities: [],
      }).type,
    ).toBe("json");
  });

  it("rejects a tool without an exact version", () => {
    expect(() =>
      ToolDefinitionSchema.parse({
        id: "builtin.json.select",
        version: "",
        displayName: "JSON Select",
        description: "Select JSON Pointer",
        executionMode: "worker",
        accepts: [],
        produces: [],
        config: {},
        requiredCapabilities: [],
        defaults: { timeoutMs: 5000, maxAttempts: 1 },
      }),
    ).toThrow();
  });

  it("rejects a zero-step execution budget", () => {
    expect(() =>
      ExecutionBudgetSchema.parse({
        maxWallClockMs: 60000,
        maxSteps: 0,
        maxAttemptsPerStep: 1,
        maxTotalAttempts: 1,
        maxOutputBytes: 1048576,
        maxHttpRequests: 1,
      }),
    ).toThrow();
  });

  it("requires exact tool version pins in workflow nodes", () => {
    expect(() =>
      WorkflowDefinitionV1Schema.parse({
        schemaVersion: 1,
        name: "Broken",
        nodes: [
          { id: "a", tool: { id: "builtin.json.select" }, config: {} },
        ],
        edges: [],
        outputs: [],
      }),
    ).toThrow();
  });
});
