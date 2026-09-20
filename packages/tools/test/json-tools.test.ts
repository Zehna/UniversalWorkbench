import { describe, expect, it } from "vitest";
import type { ContextEnvelope } from "@uw/contracts";
import {
  createJsonParseTool,
  createJsonSelectTool,
} from "../src/builtin/json/index.js";
import { ToolExecutionError } from "../src/errors.js";

const base = {
  ownerId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  executionId: "33333333-3333-4333-8333-333333333333",
  stepExecutionId: "44444444-4444-4444-8444-444444444444",
  traceId: "55555555-5555-4555-8555-555555555555",
  signal: new AbortController().signal,
};

function envelope(
  type: ContextEnvelope["type"],
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

describe("builtin json tools", () => {
  it("parses text JSON without evaluating expressions", async () => {
    const tool = createJsonParseTool({
      contextIds: { next: () => "77777777-7777-4777-8777-777777777777" },
      artifacts: {
        async getContent() {
          throw new Error("artifact should not be read");
        },
      },
    });

    const result = await tool.run({
      ...base,
      config: {},
      inputs: {
        input: envelope("text", '{"value":"globalThis.process"}'),
      },
    });

    expect(result.outputs.output?.type).toBe("json");
    expect(result.outputs.output?.payload).toEqual({
      value: "globalThis.process",
    });
  });

  it("loads an api-response body through the injected artifact reader", async () => {
    const requested: string[] = [];
    const tool = createJsonParseTool({
      contextIds: { next: () => "77777777-7777-4777-8777-777777777777" },
      artifacts: {
        async getContent(ownerId, projectId, artifactId) {
          requested.push(ownerId, projectId, artifactId);
          return new TextEncoder().encode('{"ok":true}');
        },
      },
    });

    const result = await tool.run({
      ...base,
      config: {},
      inputs: {
        input: envelope("api-response", {
          status: 200,
          headers: {},
          url: "https://example.com/data",
          bodyArtifactId: "88888888-8888-4888-8888-888888888888",
          bodyMimeType: "application/json",
          bodySizeBytes: 11,
        }),
      },
    });

    expect(requested).toEqual([
      base.ownerId,
      base.projectId,
      "88888888-8888-4888-8888-888888888888",
    ]);
    expect(result.outputs.output?.payload).toEqual({ ok: true });
  });

  it("selects the JSON Pointer root and escaped tokens", async () => {
    const tool = createJsonSelectTool({
      contextIds: {
        next: (() => {
          let index = 0;
          const ids = [
            "77777777-7777-4777-8777-777777777777",
            "88888888-8888-4888-8888-888888888888",
          ];
          return () => ids[index++]!;
        })(),
      },
    });
    const input = envelope("json", {
      "a/b": { "~key": 42 },
    });

    const root = await tool.run({
      ...base,
      config: { pointer: "" },
      inputs: { input },
    });
    expect(root.outputs.output?.payload).toEqual(input.payload);

    const escaped = await tool.run({
      ...base,
      config: { pointer: "/a~1b/~0key" },
      inputs: { input },
    });
    expect(escaped.outputs.output?.payload).toBe(42);
  });

  it("returns a structured validation error for a missing pointer", async () => {
    const tool = createJsonSelectTool({
      contextIds: { next: () => "77777777-7777-4777-8777-777777777777" },
    });

    await expect(
      tool.run({
        ...base,
        config: { pointer: "/missing" },
        inputs: { input: envelope("json", { ok: true }) },
      }),
    ).rejects.toMatchObject<ToolExecutionError>({
      code: "VALIDATION",
    });
  });
});
