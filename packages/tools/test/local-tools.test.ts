import type { ContextEnvelope } from "@uw/contracts";
import { describe, expect, it } from "vitest";
import {
  createJsonExtractTool,
  createMarkdownToTextTool,
  createTextTrimTool,
  runTool,
  ToolRuntimeError,
} from "../src/index.js";
import type { ToolRunContext } from "../src/index.js";

const envelopeId = "11111111-1111-4111-8111-111111111111";
const context: ToolRunContext = {
  executionId: "22222222-2222-4222-8222-222222222222",
  stepId: "33333333-3333-4333-8333-333333333333",
  projectId: "44444444-4444-4444-8444-444444444444",
  traceId: "55555555-5555-4555-8555-555555555555",
  signal: new AbortController().signal,
  permissions: new Set(),
};

function input(
  type: "json" | "text" | "markdown" | "api_response",
  payload: unknown,
): ContextEnvelope {
  return {
    id: envelopeId,
    type,
    schemaVersion: 1,
    mimeType: type === "json" ? "application/json" : "text/plain",
    metadata: { origin: "test" },
    payload,
    provenance: { sourceContextIds: [] },
    capabilities: ["untrusted"],
  };
}

describe("Deterministic local tools", () => {
  it("extracts a nested JSON value and preserves the original input", async () => {
    const original = input("json", {
      user: { addresses: [{ city: "Bandung" }] },
    });
    const snapshot = JSON.stringify(original);
    const result = await runTool(
      createJsonExtractTool(),
      original,
      { path: "user.addresses.0.city" },
      context,
    );

    expect(result.outputs[0]?.payload).toBe("Bandung");
    expect(result.outputs[0]?.type).toBe("json");
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(result.usage.inputBytes).toBeGreaterThan(0);
    expect(result.usage.outputBytes).toBeGreaterThan(0);
  });

  it("produces reproducible envelopes with precise provenance and no inherited capabilities", async () => {
    const source = input("text", "  hello  ");
    const first = await runTool(createTextTrimTool(), source, {}, context);
    const second = await runTool(createTextTrimTool(), source, {}, context);
    expect(first).toEqual(second);
    expect(first.outputs[0]).toMatchObject({
      type: "text",
      mimeType: "text/plain",
      metadata: { toolId: "builtin.text.trim", toolVersion: "1.0.0" },
      provenance: {
        executionId: context.executionId,
        stepId: context.stepId,
        sourceContextIds: [envelopeId],
      },
      capabilities: [],
      payload: "hello",
    });
  });

  it("does not select inherited or dangerous JSON properties", async () => {
    const source = input("json", { safe: 1 });
    await expect(
      runTool(createJsonExtractTool(), source, { path: "__proto__" }, context),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      runTool(createJsonExtractTool(), source, { path: "missing" }, context),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects malformed JSON extraction configuration", async () => {
    await expect(
      runTool(
        createJsonExtractTool(),
        input("json", { a: 1 }),
        { path: "a..b" },
        context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await expect(
      runTool(
        createJsonExtractTool(),
        input("json", { a: 1 }),
        { path: "a", extra: true },
        context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("validates input types and rejects payloads incompatible with local transforms", async () => {
    await expect(
      runTool(createTextTrimTool(), input("json", { a: 1 }), {}, context),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      runTool(
        createTextTrimTool(),
        input("text", { body: "wrong" }),
        {},
        context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects invalid configuration on tools with no options", async () => {
    await expect(
      runTool(
        createTextTrimTool(),
        input("text", " hi "),
        { unexpected: true },
        context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await expect(
      runTool(
        createMarkdownToTextTool(),
        input("markdown", "# hi"),
        null,
        context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("converts markdown to plain text without rendering or executing HTML", async () => {
    const source = input(
      "markdown",
      '# **Title**\nSee [docs](https://example.test) and `code`.\n<script>alert("unsafe")</script>',
    );
    const result = await runTool(
      createMarkdownToTextTool(),
      source,
      {},
      context,
    );
    expect(result.outputs[0]?.payload).toBe("Title\nSee docs and code.");
    expect(result.outputs[0]?.mimeType).toBe("text/plain");
  });

  it("does not treat input capabilities as authority to grant network permissions", async () => {
    const secure = createTextTrimTool();
    secure.descriptor = { ...secure.descriptor, permissions: ["network"] };
    await expect(
      runTool(secure, input("text", " x "), {}, context),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("observes cancellation before running a local transform", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runTool(
        createTextTrimTool(),
        input("text", " hi "),
        {},
        { ...context, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("rejects a malformed executor output before it reaches the workflow", async () => {
    const tool = createTextTrimTool();
    tool.run = async () => ({
      outputs: [{ ...input("json", {}), type: "json" }],
      usage: { inputBytes: 0, outputBytes: 0 },
    });
    await expect(
      runTool(tool, input("text", " x "), {}, context),
    ).rejects.toBeInstanceOf(ToolRuntimeError);
    await expect(
      runTool(tool, input("text", " x "), {}, context),
    ).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
  });
  it("extracts typed JSON directly from bounded HTTP response envelopes", async () => {
    const response = input("api_response", {
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"answer":42}',
    });
    const tool = createJsonExtractTool();
    expect(tool.descriptor.accepts).toContain("api_response");
    const result = await runTool(tool, response, { path: "answer" }, context);
    expect(result.outputs[0]?.payload).toBe(42);
    expect(result.outputs[0]?.type).toBe("json");
    await expect(
      runTool(
        tool,
        input("api_response", { status: 200, body: "{invalid" }),
        { path: "answer" },
        context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
