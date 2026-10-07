import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEgressPolicy,
  createAiTool,
  createHttpTool,
  createJsonExtractTool,
  type HttpTransport,
} from "@uw/tools";
import { createMockProvider } from "@uw/providers";
import { createWorkflowEngine } from "../src/engine.js";
import {
  MemoryStore,
  context,
  inputFor,
  node,
  registryWith,
  workflow,
} from "./fixture.js";

const AI_CANARY = "golden-ai-canary-9d4f2b7a1c5e";
const FIXTURE_URL = "https://fixture.workbench.dev/response";

afterEach(() => {
  delete process.env.WORKBENCH_AI_MOCK;
  vi.restoreAllMocks();
});

function allowMock(): void {
  process.env.WORKBENCH_AI_MOCK = "1";
}

function fixtureHttp(body: string) {
  const request = vi.fn<HttpTransport["request"]>(async () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(body),
  }));
  const policy = createEgressPolicy({
    resolver: async () => ["93.184.216.34"],
  });
  return {
    tool: createHttpTool({ policy, transport: { request } }),
    request,
  };
}

function mockAi() {
  return createAiTool({
    providers: new Map([["mock", createMockProvider()]]),
    resolveSecret: async () => AI_CANARY,
  });
}

function scanForLeaks(value: unknown): string {
  return JSON.stringify(value);
}

describe("Phase 4 golden AI workflows", () => {
  it("north-star: HTTP -> JSON extract -> AI(mock) -> note body with tokens and provenance", async () => {
    allowMock();
    const { tool: http } = fixtureHttp('{"answer": 42}');
    const extract = createJsonExtractTool();
    const ai = mockAi();
    const registry = registryWith(http, extract, ai);
    const first = node(1, http.descriptor.id, undefined, {
      config: { method: "GET", url: FIXTURE_URL },
    });
    const second = node(
      2,
      extract.descriptor.id,
      { source: "node_output", nodeId: first.id, outputIndex: 0 },
      { config: { path: "answer" } },
    );
    const third = node(
      3,
      ai.descriptor.id,
      { source: "node_output", nodeId: second.id, outputIndex: 0 },
      {
        config: {
          providerId: "mock",
          model: "atlas",
          prompt: "Summarize the answer:",
          secretRef: "secret://vault/golden-ai",
        },
      },
    );
    const definition = workflow(
      [first, second, third],
      [
        { from: first.id, to: second.id },
        { from: second.id, to: third.id },
      ],
    );
    const store = new MemoryStore();
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue({
      ...inputFor(registry, definition, context("json", {})),
      permissions: new Set(["network", "ai"]),
    });
    const view = await engine.process(created.id, new AbortController().signal);

    expect(view.execution.status).toBe("completed");
    expect(view.steps.map((step) => step.toolId)).toEqual([
      http.descriptor.id,
      extract.descriptor.id,
      ai.descriptor.id,
    ]);
    const aiOutput = view.steps[2]?.outputContexts[0];
    expect(aiOutput?.type).toBe("ai_response");
    const payload = aiOutput?.payload as {
      text: string;
      model: string;
      usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      };
      usageSource: string;
    };
    expect(payload.text.startsWith("mock:atlas:")).toBe(true);
    expect(payload.model).toBe("atlas");
    // The note body the server persists via documents/from-execution.
    expect(typeof payload.text).toBe("string");
    expect(payload.text.length).toBeGreaterThan(0);
    expect(payload.usage.totalTokens).toBeGreaterThan(0);
    expect(payload.usage.totalTokens).toBe(
      payload.usage.promptTokens + payload.usage.completionTokens,
    );
    expect(payload.usageSource).toBe("estimated");
    expect(view.execution.usage).toMatchObject({
      promptTokens: payload.usage.promptTokens,
      completionTokens: payload.usage.completionTokens,
      totalTokens: payload.usage.totalTokens,
    });
    expect(view.provenanceEdges.length).toBeGreaterThanOrEqual(3);
    expect(view.receipt).toMatchObject({ status: "completed" });
    expect(view.receipt?.outputContextIds).toContain(aiOutput?.id);
    expect(view.steps[2]).toMatchObject({
      toolId: "builtin.ai.complete",
      toolVersion: "1.0.0",
    });
    expect(scanForLeaks(view)).not.toContain(AI_CANARY);
  });

  it("structured: JSON -> AI(mock, json schema) -> artifact-savable output with usage", async () => {
    allowMock();
    const ai = mockAi();
    const registry = registryWith(ai);
    const schema = {
      type: "object",
      properties: { echo: { type: "string" } },
      required: ["echo"],
      additionalProperties: false,
    };
    const first = node(1, ai.descriptor.id, undefined, {
      config: {
        providerId: "mock",
        model: "atlas",
        prompt: "Extract:",
        secretRef: "secret://vault/golden-ai",
        responseFormat: { kind: "json", jsonSchema: schema },
      },
    });
    const definition = workflow([first], []);
    const store = new MemoryStore();
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue({
      ...inputFor(
        registry,
        definition,
        context("json", { question: "what is six times seven?" }),
      ),
      permissions: new Set(["ai"]),
    });
    const view = await engine.process(created.id, new AbortController().signal);

    expect(view.execution.status).toBe("completed");
    const aiOutput = view.steps[0]?.outputContexts[0];
    expect(aiOutput?.type).toBe("ai_response");
    const payload = aiOutput?.payload as {
      structured: { echo: string };
      usage: { totalTokens: number };
    };
    expect(typeof payload.structured.echo).toBe("string");
    expect(payload.usage.totalTokens).toBeGreaterThan(0);
    expect(view.execution.usage.totalTokens).toBe(payload.usage.totalTokens);
    // Artifact-savable: serializes well under the 512 KiB cap.
    const bytes = new TextEncoder().encode(JSON.stringify(aiOutput?.payload));
    expect(bytes.byteLength).toBeLessThan(524_288);
    expect(scanForLeaks(view)).not.toContain(AI_CANARY);
  });

  it("rejects incompatible structured output with AI_SCHEMA_MISMATCH", async () => {
    allowMock();
    const ai = mockAi();
    const registry = registryWith(ai);
    const first = node(1, ai.descriptor.id, undefined, {
      config: {
        providerId: "mock",
        model: "atlas",
        prompt: "Extract:",
        secretRef: "secret://vault/golden-ai",
        responseFormat: { kind: "json", jsonSchema: { type: "array" } },
      },
      retry: { maxAttempts: 3, backoffMs: 0 },
      idempotencyKey: "golden-mismatch-1",
    });
    const store = new MemoryStore();
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue({
      ...inputFor(registry, workflow([first], []), context("text", "hi")),
      permissions: new Set(["ai"]),
    });
    const view = await engine.process(created.id, new AbortController().signal);

    expect(view.execution.status).toBe("failed");
    expect(view.steps).toHaveLength(1);
    expect(view.steps[0]?.error).toMatchObject({
      code: "AI_SCHEMA_MISMATCH",
    });
    expect(scanForLeaks(view)).not.toContain(AI_CANARY);
  });

  it("bad secretRef fails structured with one attempt and no leak", async () => {
    allowMock();
    const ai = mockAi();
    const registry = registryWith(ai);
    const first = node(1, ai.descriptor.id, undefined, {
      config: {
        providerId: "mock",
        model: "atlas",
        prompt: "Summarize:",
        secretRef: "not-a-secret-ref",
      },
      retry: { maxAttempts: 5, backoffMs: 0 },
      idempotencyKey: "golden-badref-1",
    });
    const store = new MemoryStore();
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue({
      ...inputFor(registry, workflow([first], []), context("text", "hi")),
      permissions: new Set(["ai"]),
    });
    const view = await engine.process(created.id, new AbortController().signal);

    expect(view.execution.status).toBe("failed");
    // No retry storm: structured config errors never retry.
    expect(view.steps).toHaveLength(1);
    expect(view.steps[0]?.error).toMatchObject({ code: "INVALID_CONFIG" });
    expect(scanForLeaks(view)).not.toContain(AI_CANARY);
    expect(scanForLeaks(view)).not.toContain("vault-plaintext");
  });
});
