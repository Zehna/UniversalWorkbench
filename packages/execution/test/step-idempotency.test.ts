import { describe, expect, it, vi } from "vitest";
import type { ContextEnvelope } from "@uw/contracts";
import type { ExecutionOutputRepository } from "../src/output.js";

describe("execution output persistence contract", () => {
  it("persists all output contexts before a step can be marked succeeded", async () => {
    const order: string[] = [];
    const outputs: ExecutionOutputRepository = {
      async appendMany(records) {
        expect(records).toHaveLength(1);
        order.push("outputs");
      },
      async listByStep() {
        return [];
      },
    };

    const transition = vi.fn(async (input: { to: string }) => {
      if (input.to === "succeeded") order.push("step-succeeded");
      return null;
    });

    const context: ContextEnvelope = {
      id: "11111111-1111-4111-8111-111111111111",
      type: "text",
      schemaVersion: 1,
      mimeType: "text/plain",
      metadata: {},
      payload: "done",
      provenance: {
        projectId: "22222222-2222-4222-8222-222222222222",
        artifactIds: [],
        parentContextIds: [],
      },
      capabilities: [],
    };

    const module = await import("../src/output.js");
    await module.persistStepOutputsBeforeSuccess({
      outputs,
      contexts: { output: context },
      executionId: "33333333-3333-4333-8333-333333333333",
      stepExecutionId: "44444444-4444-4444-8444-444444444444",
      idGenerator: {
        next: () => "55555555-5555-4555-8555-555555555555",
      },
      clock: {
        now: () => new Date("2026-09-20T00:00:00.000Z"),
      },
      markSucceeded: () => transition({ to: "succeeded" }),
    });

    expect(order).toEqual(["outputs", "step-succeeded"]);
  });
});
