import type { ContextEnvelope } from "@uw/contracts";
import { describe, expect, it, vi } from "vitest";
import { createAiTool, runTool, ToolRuntimeError } from "../src/index.js";
import type { ToolRunContext } from "../src/index.js";

const ENVELOPE_ID = "11111111-1111-4111-8111-111111111111";

function baseContext(overrides: Partial<ToolRunContext> = {}): ToolRunContext {
  return {
    executionId: "22222222-2222-4222-8222-222222222222",
    stepId: "33333333-3333-4333-8333-333333333333",
    projectId: "44444444-4444-4444-8444-444444444444",
    traceId: "55555555-5555-4555-8555-555555555555",
    signal: new AbortController().signal,
    permissions: new Set(["ai"]),
    ...overrides,
  };
}

function input(
  type: "text" | "markdown" | "json",
  payload: unknown,
): ContextEnvelope {
  return {
    id: ENVELOPE_ID,
    type,
    schemaVersion: 1,
    mimeType: type === "json" ? "application/json" : "text/plain",
    metadata: {},
    payload,
    provenance: { sourceContextIds: [] },
    capabilities: [],
  };
}

function portDouble(result: Record<string, unknown> = {}) {
  const complete = vi.fn(async (req: Record<string, unknown>) => ({
    text: "hello world",
    model: "test-model",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    usageSource: "provider" as const,
    providerRequestId: "req-123",
    ...result,
  }));
  return { id: "test-provider", complete };
}

function depsWith(
  provider: { id: string; complete: (req: never) => Promise<never> } | ReturnType<typeof portDouble>,
  resolveSecret: (ref: string) => Promise<string> = async () => "super-secret-value-abc123",
) {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: port double intentionally structural
    providers: new Map([["test-provider", provider as any]]),
    resolveSecret,
  };
}

const validConfig = {
  providerId: "test-provider",
  model: "test-model",
  prompt: "Summarize:",
  secretRef: "secret://vault/openai",
};

describe("builtin.ai.complete@1.0.0", () => {
  it("has the pinned descriptor shape", async () => {
    const tool = createAiTool(depsWith(portDouble()));
    expect(tool.descriptor.id).toBe("builtin.ai.complete");
    expect(tool.descriptor.version).toBe("1.0.0");
    expect(tool.descriptor.accepts).toEqual(["text", "markdown", "json"]);
    expect(tool.descriptor.produces).toEqual(["ai_response"]);
    expect(tool.descriptor.permissions).toEqual(["ai"]);
    expect(tool.descriptor.capabilities).toEqual(["structured-output"]);
    expect(tool.descriptor.executionMode).toBe("server");
    expect(tool.descriptor.idempotency).toBe("keyed");
  });

  it("completes text input into an ai_response envelope (happy path)", async () => {
    const port = portDouble();
    const tool = createAiTool(depsWith(port));
    const result = await runTool(
      tool,
      input("text", "hello input"),
      validConfig,
      baseContext(),
    );
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]?.type).toBe("ai_response");
    expect(result.outputs[0]?.payload).toMatchObject({
      text: "hello world",
      model: "test-model",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      usageSource: "provider",
      providerRequestId: "req-123",
    });
    expect(port.complete).toHaveBeenCalledTimes(1);
    const req = port.complete.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(req.model).toBe("test-model");
    expect(String(req.prompt)).toContain("Summarize:");
    expect(String(req.prompt)).toContain("hello input");
    expect(req.secretValue).toBe("super-secret-value-abc123");
  });

  it("accepts markdown and json inputs by folding them into the prompt", async () => {
    const port = portDouble({ text: "md ok" });
    const tool = createAiTool(depsWith(port));
    const md = await runTool(
      tool,
      input("markdown", "# Title hello"),
      validConfig,
      baseContext(),
    );
    expect(md.outputs[0]?.type).toBe("ai_response");

    const port2 = portDouble({ text: "json ok" });
    const tool2 = createAiTool(depsWith(port2));
    const js = await runTool(
      tool2,
      input("json", { question: "what?" }),
      validConfig,
      baseContext(),
    );
    expect(js.outputs[0]?.type).toBe("ai_response");
    const req2 = port2.complete.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(req2.prompt)).toContain('"question"');
  });

  it("passes json-schema validation and surfaces structured output", async () => {
    const port = portDouble({
      text: '{"answer":42}',
      structured: { answer: 42 },
    });
    const tool = createAiTool(depsWith(port));
    const result = await runTool(
      tool,
      input("text", "extract"),
      {
        ...validConfig,
        responseFormat: {
          kind: "json",
          jsonSchema: {
            type: "object",
            properties: { answer: { type: "number" } },
            required: ["answer"],
          },
        },
      },
      baseContext(),
    );
    expect(result.outputs[0]?.payload).toMatchObject({
      structured: { answer: 42 },
    });
  });

  it("fails with AI_SCHEMA_MISMATCH when json output violates the schema", async () => {
    const port = portDouble({
      text: '{"answer":"not-a-number"}',
      structured: { answer: "not-a-number" },
    });
    const tool = createAiTool(depsWith(port));
    const error = await runTool(
      tool,
      input("text", "extract"),
      {
        ...validConfig,
        responseFormat: {
          kind: "json",
          jsonSchema: {
            type: "object",
            properties: { answer: { type: "number" } },
            required: ["answer"],
          },
        },
      },
      baseContext(),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ToolRuntimeError);
    expect(error).toMatchObject({ code: "AI_SCHEMA_MISMATCH" });
  });

  it("fails when the secret cannot be resolved without leaking the value", async () => {
    const secretValue = "super-secret-value-abc123";
    const tool = createAiTool(
      depsWith(portDouble(), async () => {
        throw new Error(`vault read failed containing ${secretValue} bytes`);
      }),
    );
    const error = await runTool(
      tool,
      input("text", "hi"),
      validConfig,
      baseContext(),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ToolRuntimeError);
    const text = `${(error as Error).message} ${(error as Error).stack ?? ""} ${JSON.stringify(error)}`;
    expect(text).not.toContain(secretValue);
    expect(text).not.toContain("vault read failed containing");
  });

  it("never echoes secret-like config values in errors", async () => {
    const port = portDouble();
    const tool = createAiTool(depsWith(port));
    const error = await runTool(
      tool,
      input("text", "hi"),
      { ...validConfig, maxOutputTokens: 999_999 },
      baseContext(),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "INVALID_CONFIG" });
    expect(JSON.stringify(error)).not.toContain("999999");
    expect((error as Error).message).not.toContain("super-secret");
  });

  it("forwards the node idempotencyKey to the provider", async () => {
    const port = portDouble();
    const tool = createAiTool(depsWith(port));
    await runTool(
      tool,
      input("text", "hi"),
      validConfig,
      baseContext({ idempotencyKey: "idem-abc-123" }),
    );
    const req = port.complete.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(req.idempotencyKey).toBe("idem-abc-123");
  });

  it("rejects unknown providerId (including mock when not injected)", async () => {
    const tool = createAiTool(depsWith(portDouble()));
    await expect(
      runTool(
        tool,
        input("text", "hi"),
        { ...validConfig, providerId: "mock" },
        baseContext(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("rejects invalid config: empty model, malformed secretRef, bad tokens", async () => {
    const tool = createAiTool(depsWith(portDouble()));
    await expect(
      runTool(
        tool,
        input("text", "hi"),
        { ...validConfig, model: "  " },
        baseContext(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await expect(
      runTool(
        tool,
        input("text", "hi"),
        { ...validConfig, secretRef: "not-a-secret-ref" },
        baseContext(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await expect(
      runTool(tool, input("text", "hi"), { ...validConfig }, baseContext()),
    ).resolves.toBeTruthy();
  });

  it("redacts secret bytes when the provider itself fails", async () => {
    const secretValue = "super-secret-value-abc123";
    const failing = {
      id: "test-provider",
      complete: vi.fn(async () => {
        throw new Error(`provider blew up on ${secretValue}`);
      }),
    };
    const tool = createAiTool(depsWith(failing, async () => secretValue));
    const error = await runTool(
      tool,
      input("text", "hi"),
      validConfig,
      baseContext(),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ToolRuntimeError);
    const text = `${(error as Error).message} ${JSON.stringify(error)}`;
    expect(text).not.toContain(secretValue);
  });
});
