import { describe, expect, it } from "vitest";
import {
  ContextEnvelopeSchema,
  ContextTypeSchema,
  ExecutionStatusSchema,
  ToolDescriptorSchema,
  WorkflowDefinitionSchema,
} from "../src/index.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const WORKFLOW_ID = "22222222-2222-4222-8222-222222222222";
const NODE_A = "33333333-3333-4333-8333-333333333333";
const NODE_B = "44444444-4444-4444-8444-444444444444";
const CONTEXT_ID = "55555555-5555-4555-8555-555555555555";

describe("phase 3 contracts", () => {
  it("accepts a versioned typed context envelope", () => {
    const value = {
      id: CONTEXT_ID,
      type: "json",
      schemaVersion: 1,
      mimeType: "application/json",
      metadata: { source: "fixture" },
      payload: { answer: 42 },
      provenance: { sourceContextIds: [] },
      capabilities: ["copy"],
    };

    expect(ContextEnvelopeSchema.parse(value)).toEqual(value);
  });

  it("rejects unsupported context types and schema versions", () => {
    expect(ContextTypeSchema.safeParse("binary_blob").success).toBe(false);
    expect(
      ContextEnvelopeSchema.safeParse({
        id: CONTEXT_ID,
        type: "json",
        schemaVersion: 2,
        mimeType: "application/json",
        metadata: {},
        payload: {},
        provenance: { sourceContextIds: [] },
        capabilities: [],
      }).success,
    ).toBe(false);
  });

  it("accepts an exact-version tool descriptor", () => {
    const descriptor = {
      id: "builtin.json.extract",
      version: "1.0.0",
      name: "JSON Extract",
      description: "Extract a JSON value by path",
      accepts: ["json"],
      produces: ["json"],
      permissions: [],
      capabilities: ["transform"],
      executionMode: "local",
      idempotency: "safe",
      configSchema: { type: "object" },
    };

    expect(ToolDescriptorSchema.parse(descriptor)).toEqual(descriptor);
  });

  it("rejects duplicate workflow node IDs", () => {
    const workflow = {
      id: WORKFLOW_ID,
      projectId: PROJECT_ID,
      name: "Duplicate nodes",
      schemaVersion: 1,
      nodes: [
        {
          id: NODE_A,
          toolId: "builtin.text.trim",
          toolVersion: "1.0.0",
          config: {},
          input: { source: "workflow_input" },
        },
        {
          id: NODE_A,
          toolId: "builtin.markdown.to-text",
          toolVersion: "1.0.0",
          config: {},
          input: { source: "node_output", nodeId: NODE_B, outputIndex: 0 },
        },
      ],
      edges: [{ from: NODE_B, to: NODE_A }],
    };

    expect(WorkflowDefinitionSchema.safeParse(workflow).success).toBe(false);
  });

  it("keeps execution status closed over the six durable states", () => {
    for (const status of [
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ]) {
      expect(ExecutionStatusSchema.parse(status)).toBe(status);
    }

    expect(ExecutionStatusSchema.safeParse("retrying").success).toBe(false);
  });
});
