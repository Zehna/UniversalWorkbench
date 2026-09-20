import { describe, expect, it } from "vitest";
import type { ContextEnvelope } from "@uw/contracts";
import { createTextTemplateTool } from "../src/builtin/text/template.js";

const base = {
  ownerId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  executionId: "33333333-3333-4333-8333-333333333333",
  stepExecutionId: "44444444-4444-4444-8444-444444444444",
  traceId: "55555555-5555-4555-8555-555555555555",
  signal: new AbortController().signal,
};

function input(
  type: "text" | "markdown" | "json",
  payload: ContextEnvelope["payload"],
): ContextEnvelope {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    type,
    schemaVersion: 1,
    mimeType: type === "json" ? "application/json" : "text/plain",
    metadata: {},
    payload,
    provenance: {
      projectId: base.projectId,
      artifactIds: [],
      parentContextIds: [],
    },
    capabilities: [],
  };
}

describe("builtin text.template", () => {
  it("renders only the constrained input and JSON Pointer placeholders", async () => {
    const tool = createTextTemplateTool({
      contextIds: { next: () => "77777777-7777-4777-8777-777777777777" },
    });

    const result = await tool.run({
      ...base,
      config: {
        template: "Title: {{json:/title}}\n{{input}}",
        outputType: "markdown",
      },
      inputs: {
        input: input("text", "Body"),
        json: input("json", { title: "Hello" }),
      },
    });

    expect(result.outputs.output).toMatchObject({
      type: "markdown",
      payload: "Title: Hello\nBody",
    });
  });

  it("rejects unknown placeholders instead of evaluating expressions", async () => {
    const tool = createTextTemplateTool({
      contextIds: { next: () => "77777777-7777-4777-8777-777777777777" },
    });

    await expect(
      tool.run({
        ...base,
        config: { template: "{{process.env.SECRET}}", outputType: "text" },
        inputs: { input: input("text", "safe") },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
