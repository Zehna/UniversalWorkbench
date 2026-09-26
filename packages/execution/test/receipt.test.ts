import { describe, expect, it } from "vitest";
import { createExecutionReceipt } from "../src/receipt.js";
import { safeExecutionError } from "../src/errors.js";
import { context, node, uuid, workflow } from "./fixture.js";

describe("immutable final receipt payload", () => {
  it("records versions, timings, usage, IDs and provenance without configuration secrets", () => {
    const input = context("json", { token: "private-input" }, uuid(80));
    const output = context("text", "SECRET_OUTPUT_PAYLOAD", uuid(81));
    output.provenance = {
      executionId: uuid(60),
      stepId: uuid(61),
      sourceContextIds: [input.id],
    };
    const action = node(1, "builtin.http.request", undefined, {
      config: {
        method: "POST",
        url: "https://example.com",
        headers: { Authorization: "Bearer sk-super-secret" },
        apiKey: "another-private-token",
      },
      idempotencyKey: "secret-idempotency-token",
    });
    const report = createExecutionReceipt({
      executionId: uuid(60),
      workflow: workflow([action]),
      workflowVersion: 3,
      status: "completed",
      startedAt: new Date("2026-09-26T12:00:00.000Z"),
      finishedAt: new Date("2026-09-26T12:00:01.000Z"),
      usage: { attempts: 1, inputBytes: 50, outputBytes: 120 },
      steps: [
        {
          id: uuid(61),
          executionId: uuid(60),
          nodeId: action.id,
          toolId: action.toolId,
          toolVersion: action.toolVersion,
          attempt: 1,
          status: "completed",
          startedAt: new Date("2026-09-26T12:00:00.000Z"),
          finishedAt: new Date("2026-09-26T12:00:01.000Z"),
          inputContext: input,
          outputContexts: [output],
          error: null,
          idempotencyKey: action.idempotencyKey ?? null,
        },
      ],
    });
    expect(report).toMatchObject({
      workflowId: uuid(70),
      workflowVersion: 3,
      status: "completed",
      usage: { attempts: 1, inputBytes: 50, outputBytes: 120 },
      outputContextIds: [output.id],
      provenance: [
        {
          fromContextId: input.id,
          toContextId: output.id,
          nodeId: action.id,
        },
      ],
    });
    const serialized = JSON.stringify(report);
    for (const secret of [
      "Authorization",
      "Bearer",
      "sk-super-secret",
      "apiKey",
      "another-private-token",
      "secret-idempotency-token",
      "SECRET_OUTPUT_PAYLOAD",
      "private-input",
    ])
      expect(serialized).not.toContain(secret);
  });

  it("sanitizes arbitrary upstream error messages", () => {
    const result = safeExecutionError(new Error("Bearer confidential-token"));
    expect(result).toEqual({
      code: "TOOL_FAILED",
      message: "Workflow tool execution failed",
      details: null,
    });
    expect(JSON.stringify(result)).not.toContain("confidential-token");
  });
});
