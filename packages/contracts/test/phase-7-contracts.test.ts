import { describe, expect, it } from "vitest";
import {
  AgentApprovalRequestSchema,
  AgentApprovalResolutionSchema,
  AgentStatusSchema,
  ExecutionStatusSchema,
  ToolDescriptorSchema,
} from "../src/index.js";

const BASE_DESCRIPTOR = {
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
} as const;

describe("phase 7 hitl contracts", () => {
  it("accepts awaiting_approval execution status", () => {
    expect(ExecutionStatusSchema.parse("awaiting_approval")).toBe(
      "awaiting_approval",
    );
  });

  it("accepts awaiting_approval agent status", () => {
    expect(AgentStatusSchema.parse("awaiting_approval")).toBe(
      "awaiting_approval",
    );
  });

  it("defaults requiresApproval to false on tool descriptors", () => {
    const parsed = ToolDescriptorSchema.parse({ ...BASE_DESCRIPTOR });
    expect(parsed.requiresApproval).toBe(false);
  });

  it("accepts explicit requiresApproval true/false", () => {
    expect(
      ToolDescriptorSchema.parse({ ...BASE_DESCRIPTOR, requiresApproval: true })
        .requiresApproval,
    ).toBe(true);
    expect(
      ToolDescriptorSchema.parse({
        ...BASE_DESCRIPTOR,
        requiresApproval: false,
      }).requiresApproval,
    ).toBe(false);
  });

  it("parses a valid agent approval request", () => {
    const request = {
      executionId: "11111111-1111-4111-8111-111111111111",
      nodeId: "22222222-2222-4222-8222-222222222222",
      toolCall: {
        name: "builtin.http.request",
        arguments: { url: "https://example.com" },
      },
    };
    const parsed = AgentApprovalRequestSchema.parse(request);
    expect(parsed.executionId).toBe(request.executionId);
    expect(parsed.nodeId).toBe(request.nodeId);
    expect(parsed.toolCall.name).toBe("builtin.http.request");
  });

  it("parses an approval request with optional reason", () => {
    const parsed = AgentApprovalRequestSchema.parse({
      executionId: "11111111-1111-4111-8111-111111111111",
      nodeId: "22222222-2222-4222-8222-222222222222",
      toolCall: { name: "builtin.http.request", arguments: {} },
      reason: "needs human review",
    });
    expect(parsed.reason).toBe("needs human review");
  });

  it("rejects an approval request missing toolCall", () => {
    expect(
      AgentApprovalRequestSchema.safeParse({
        executionId: "11111111-1111-4111-8111-111111111111",
        nodeId: "22222222-2222-4222-8222-222222222222",
      }).success,
    ).toBe(false);
  });

  it("parses approved and rejected approval resolutions", () => {
    expect(
      AgentApprovalResolutionSchema.parse({ decision: "approved" }).decision,
    ).toBe("approved");
    const rejected = AgentApprovalResolutionSchema.parse({
      decision: "rejected",
      rejectionReason: "too risky",
    });
    expect(rejected.decision).toBe("rejected");
    expect(rejected.rejectionReason).toBe("too risky");
  });

  it("rejects invalid approval decisions", () => {
    expect(
      AgentApprovalResolutionSchema.safeParse({ decision: "pending" }).success,
    ).toBe(false);
    expect(AgentApprovalResolutionSchema.safeParse({}).success).toBe(false);
  });
});
