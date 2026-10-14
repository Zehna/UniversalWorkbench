import { describe, expect, it } from "vitest";
import {
  createCodeInterpreterTool,
  CODE_INTERPRETER_TOOL_NAME,
} from "../src/builtin/code.js";
import { createId } from "../src/runtime.js";

describe("builtin.code.interpreter", () => {
  const tool = createCodeInterpreterTool();

  it("has valid descriptor shape", () => {
    expect(tool.descriptor.id).toBe("builtin.code.interpreter");
    expect(tool.descriptor.version).toBe("1.0.0");
    expect(tool.descriptor.accepts).toContain("json");
    expect(tool.descriptor.produces).toContain("code_result");
    expect(CODE_INTERPRETER_TOOL_NAME).toBe("builtin.code.interpreter@1.0.0");
  });

  it("executes computation script and returns code_result envelope", async () => {
    const inputEnvelope = {
      id: createId(),
      type: "json" as const,
      schemaVersion: 1 as const,
      mimeType: "application/json",
      metadata: {},
      payload: { x: 10, y: 32 },
      provenance: { sourceContextIds: [] },
      capabilities: [],
    };

    const result = await tool.run(
      inputEnvelope,
      {
        code: "console.log('Calculating...'); return input.x + input.y;",
        timeoutMs: 3000,
      },
      {
        ownerId: "owner-1",
        executionId: createId(),
        stepId: "step-1",
        attempt: 1,
      },
    );

    expect(result.outputContexts).toHaveLength(1);
    const output = result.outputContexts[0]!;
    expect(output.type).toBe("code_result");
    const payload = output.payload as { success: boolean; result: unknown; stdout: string };
    expect(payload.success).toBe(true);
    expect(payload.result).toBe(42);
    expect(payload.stdout).toContain("Calculating...");
  });

  it("rejects invalid config", async () => {
    const inputEnvelope = {
      id: createId(),
      type: "text" as const,
      schemaVersion: 1 as const,
      mimeType: "text/plain",
      metadata: {},
      payload: "hello",
      provenance: { sourceContextIds: [] },
      capabilities: [],
    };

    await expect(
      tool.run(inputEnvelope, { code: "" }, {
        ownerId: "owner-1",
        executionId: createId(),
        stepId: "step-1",
        attempt: 1,
      }),
    ).rejects.toThrow("INVALID_CONFIG");
  });

  it("throws ToolRuntimeError on script execution failure", async () => {
    const inputEnvelope = {
      id: createId(),
      type: "text" as const,
      schemaVersion: 1 as const,
      mimeType: "text/plain",
      metadata: {},
      payload: "test",
      provenance: { sourceContextIds: [] },
      capabilities: [],
    };

    await expect(
      tool.run(inputEnvelope, { code: "throw new Error('Script failure');" }, {
        ownerId: "owner-1",
        executionId: createId(),
        stepId: "step-1",
        attempt: 1,
      }),
    ).rejects.toThrow("Script failure");
  });
});
