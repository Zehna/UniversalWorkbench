import type { ContextEnvelope } from "@uw/contracts";
import { describe, expect, it, vi } from "vitest";
import { createAgentTool, runTool, createTextTrimTool } from "../src/index.js";
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

function textInput(payload: unknown): ContextEnvelope {
  return {
    id: ENVELOPE_ID,
    type: "text",
    schemaVersion: 1,
    mimeType: "text/plain",
    metadata: {},
    payload,
    provenance: { sourceContextIds: [] },
    capabilities: [],
  };
}

interface ProviderResultDouble {
  text: string;
  model?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  usageSource?: "provider" | "estimated";
  toolCalls?: Array<{
    id?: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

function providerDouble(sequence: ProviderResultDouble[]) {
  const complete = vi.fn(async (_req: Record<string, unknown>) => {
    const callIndex = complete.mock.calls.length - 1;
    const next: ProviderResultDouble = sequence[
      Math.min(callIndex, Math.max(0, sequence.length - 1))
    ] ?? { text: "" };
    return {
      model: "test-model",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      usageSource: "provider" as const,
      ...next,
    };
  });
  return { id: "test-provider", complete };
}

function depsWith(
  provider: ReturnType<typeof providerDouble>,
  tools: ReturnType<typeof createTextTrimTool>[] = [],
  resolveSecret: (ref: string) => Promise<string> = async () =>
    "super-secret-value-abc123",
) {
  return {
    providers: new Map([["test-provider", provider as never]]),
    resolveSecret,
    tools: tools as never[],
  };
}

const TRIM_NAME = "builtin.text.trim@1.0.0";

const baseConfig = {
  providerId: "test-provider",
  model: "test-model",
  prompt: "Answer the question:",
  secretRef: "secret://vault/openai",
};

describe("builtin.ai.agent@1.0.0", () => {
  it("has the pinned descriptor shape", () => {
    const tool = createAgentTool(depsWith(providerDouble([])));
    expect(tool.descriptor.id).toBe("builtin.ai.agent");
    expect(tool.descriptor.version).toBe("1.0.0");
    expect(tool.descriptor.produces).toEqual(["agent_response"]);
    expect(tool.descriptor.permissions).toEqual(["ai"]);
  });

  it("completes directly without tools (1 iteration, status completed)", async () => {
    const provider = providerDouble([
      {
        text: "final answer",
        usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
      },
    ]);
    const tool = createAgentTool(depsWith(provider));
    const result = await runTool(
      tool,
      textInput("hello"),
      { ...baseConfig, allowedTools: [] },
      baseContext(),
    );
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]?.type).toBe("agent_response");
    expect(result.outputs[0]?.payload).toMatchObject({
      text: "final answer",
      model: "test-model",
      status: "completed",
      iterations: 1,
      usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
    });
    const payload = result.outputs[0]?.payload as {
      trace: Array<Record<string, unknown>>;
    };
    expect(payload.trace).toHaveLength(1);
    expect(payload.trace[0]).toMatchObject({ iteration: 1 });
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it("executes multi-step tool calls (tool called -> observation -> final answer)", async () => {
    const trimTool = createTextTrimTool();
    const provider = providerDouble([
      {
        text: "I need to trim the input",
        toolCalls: [{ id: "call_1", name: TRIM_NAME, arguments: {} }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        text: "done: hello",
        usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 },
      },
    ]);
    const tool = createAgentTool(depsWith(provider, [trimTool]));
    const result = await runTool(
      tool,
      textInput("  hello  "),
      { ...baseConfig, allowedTools: [TRIM_NAME] },
      baseContext(),
    );
    expect(provider.complete).toHaveBeenCalledTimes(2);
    const payload = result.outputs[0]?.payload as {
      text: string;
      status: string;
      iterations: number;
      trace: Array<{
        iteration: number;
        thought?: string;
        toolCall?: { name: string };
        observation?: { output: unknown };
      }>;
    };
    expect(payload.status).toBe("completed");
    expect(payload.iterations).toBe(2);
    expect(payload.text).toBe("done: hello");
    expect(payload.trace).toHaveLength(2);
    expect(payload.trace[0]?.toolCall?.name).toBe(TRIM_NAME);
    expect(JSON.stringify(payload.trace[0]?.observation?.output)).toContain(
      "hello",
    );
  });

  it("stops at maxIterations with status iteration_limit_reached", async () => {
    const trimTool = createTextTrimTool();
    const provider = providerDouble([
      {
        text: "keep going",
        toolCalls: [{ id: "call_1", name: TRIM_NAME, arguments: {} }],
        usage: { promptTokens: 3, completionTokens: 3, totalTokens: 6 },
      },
      {
        text: "still going",
        toolCalls: [{ id: "call_2", name: TRIM_NAME, arguments: {} }],
        usage: { promptTokens: 3, completionTokens: 3, totalTokens: 6 },
      },
      {
        text: "should never reach",
        usage: { promptTokens: 3, completionTokens: 3, totalTokens: 6 },
      },
    ]);
    const tool = createAgentTool(depsWith(provider, [trimTool]));
    const result = await runTool(
      tool,
      textInput("  hello  "),
      { ...baseConfig, allowedTools: [TRIM_NAME], maxIterations: 2 },
      baseContext(),
    );
    const payload = result.outputs[0]?.payload as {
      status: string;
      iterations: number;
      trace: unknown[];
    };
    expect(payload.status).toBe("iteration_limit_reached");
    expect(payload.iterations).toBe(2);
    expect(payload.trace).toHaveLength(2);
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  it("accumulates promptTokens and completionTokens across iterations", async () => {
    const trimTool = createTextTrimTool();
    const provider = providerDouble([
      {
        text: "step one",
        toolCalls: [{ id: "call_1", name: TRIM_NAME, arguments: {} }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        text: "final",
        usage: { promptTokens: 20, completionTokens: 7, totalTokens: 27 },
      },
    ]);
    const tool = createAgentTool(depsWith(provider, [trimTool]));
    const result = await runTool(
      tool,
      textInput("  hello  "),
      { ...baseConfig, allowedTools: [TRIM_NAME] },
      baseContext(),
    );
    expect(result.outputs[0]?.payload).toMatchObject({
      usage: { promptTokens: 30, completionTokens: 12, totalTokens: 42 },
    });
  });
});
