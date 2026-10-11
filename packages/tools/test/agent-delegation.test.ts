import type { ContextEnvelope } from "@uw/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentTool,
  runTool,
  createTextTrimTool,
  DELEGATION_TOOL_NAME,
  runSubAgentDelegation,
} from "../src/index.js";
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
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
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
  prompt: "You are a supervisor. Delegate research when needed.",
  secretRef: "secret://vault/openai",
};

const researcherSpec = {
  id: "researcher",
  role: "researcher",
  instructions: "You are a concise research specialist.",
  allowedTools: [] as string[],
  maxIterations: 5,
};

describe("sub-agent delegation with budget cascading", () => {
  it("exposes delegation tool name", () => {
    expect(DELEGATION_TOOL_NAME).toBe("builtin.agent.delegate@1.0.0");
    expect(typeof runSubAgentDelegation).toBe("function");
  });

  it("supervisor delegating a sub-task to a specialist sub-agent", async () => {
    const provider = providerDouble([
      {
        text: "delegating to researcher",
        toolCalls: [
          {
            id: "sup_1",
            name: DELEGATION_TOOL_NAME,
            arguments: { subAgentId: "researcher", task: "summarize topic X" },
          },
        ],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        text: "child answer",
        usage: { promptTokens: 4, completionTokens: 4, totalTokens: 8 },
      },
      {
        text: "final: child said hello",
        usage: { promptTokens: 6, completionTokens: 6, totalTokens: 12 },
      },
    ]);
    const tool = createAgentTool(depsWith(provider));
    const result = await runTool(
      tool,
      textInput("research topic X"),
      {
        ...baseConfig,
        allowedTools: [],
        maxIterations: 5,
        subAgents: [researcherSpec],
      },
      baseContext(),
    );
    const payload = result.outputs[0]?.payload as {
      text: string;
      status: string;
      trace: Array<{ toolCall?: { name: string } }>;
    };
    expect(payload.status).toBe("completed");
    expect(payload.text).toContain("child said hello");
    expect(provider.complete).toHaveBeenCalledTimes(3);
  });

  it("sub-agent executes its own scoped tool and returns results", async () => {
    const trimTool = createTextTrimTool();
    const provider = providerDouble([
      {
        text: "delegating trim work",
        toolCalls: [
          {
            id: "sup_1",
            name: DELEGATION_TOOL_NAME,
            arguments: { subAgentId: "formatter", task: "trim this" },
          },
        ],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        text: "child needs trim",
        toolCalls: [{ id: "child_1", name: TRIM_NAME, arguments: {} }],
        usage: { promptTokens: 3, completionTokens: 3, totalTokens: 6 },
      },
      {
        text: "trimmed: hello",
        usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
      },
      {
        text: "final: trimmed: hello",
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      },
    ]);
    const tool = createAgentTool(depsWith(provider, [trimTool]));
    const result = await runTool(
      tool,
      textInput("  hello  "),
      {
        ...baseConfig,
        allowedTools: [],
        maxIterations: 5,
        subAgents: [
          {
            id: "formatter",
            role: "formatter",
            instructions: "Trim text using tools.",
            allowedTools: [TRIM_NAME],
            maxIterations: 3,
          },
        ],
      },
      baseContext(),
    );
    const payload = result.outputs[0]?.payload as { text: string };
    expect(payload.text).toContain("trimmed");
    expect(provider.complete).toHaveBeenCalledTimes(4);
  });

  it("nested trace structure properly captured in supervisor observation", async () => {
    const provider = providerDouble([
      {
        text: "delegating",
        toolCalls: [
          {
            id: "sup_1",
            name: DELEGATION_TOOL_NAME,
            arguments: { subAgentId: "researcher", task: "deep dive" },
          },
        ],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        text: "child final",
        usage: { promptTokens: 4, completionTokens: 4, totalTokens: 8 },
      },
      {
        text: "supervisor final",
        usage: { promptTokens: 6, completionTokens: 6, totalTokens: 12 },
      },
    ]);
    const tool = createAgentTool(depsWith(provider));
    const result = await runTool(
      tool,
      textInput("go"),
      {
        ...baseConfig,
        allowedTools: [],
        maxIterations: 5,
        subAgents: [researcherSpec],
      },
      baseContext(),
    );
    const payload = result.outputs[0]?.payload as {
      trace: Array<{
        iteration: number;
        toolCall?: { name: string };
        observation?: { output: unknown };
        nestedTrace?: {
          subAgentId: string;
          role: string;
          trace: unknown[];
          status: string;
          usage: { promptTokens: number };
        };
      }>;
    };
    const delegateItem = payload.trace.find(
      (t) => t.toolCall?.name === DELEGATION_TOOL_NAME,
    );
    expect(delegateItem).toBeDefined();
    expect(delegateItem?.nestedTrace?.subAgentId).toBe("researcher");
    expect(delegateItem?.nestedTrace?.role).toBe("researcher");
    expect(Array.isArray(delegateItem?.nestedTrace?.trace)).toBe(true);
    expect(delegateItem?.nestedTrace?.status).toBe("completed");
    expect(delegateItem?.nestedTrace?.usage).toMatchObject({
      promptTokens: 4,
    });
  });

  it("strict budget cascading caps sub-agent iterations", async () => {
    const trimTool = createTextTrimTool();
    const provider = providerDouble([
      {
        text: "supervisor step one",
        toolCalls: [{ id: "sup_trim", name: TRIM_NAME, arguments: {} }],
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      },
      {
        text: "supervisor delegating late",
        toolCalls: [
          {
            id: "sup_2",
            name: DELEGATION_TOOL_NAME,
            arguments: { subAgentId: "researcher", task: "late work" },
          },
        ],
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      },
      {
        text: "child keeps going",
        toolCalls: [{ id: "child_1", name: TRIM_NAME, arguments: {} }],
        usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
      },
      {
        text: "child should never reach here",
        usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
      },
    ]);
    const tool = createAgentTool(depsWith(provider, [trimTool]));
    const result = await runTool(
      tool,
      textInput("  hello  "),
      {
        ...baseConfig,
        allowedTools: [TRIM_NAME],
        maxIterations: 2,
        subAgents: [
          {
            id: "researcher",
            role: "researcher",
            instructions: "Keep working.",
            allowedTools: [TRIM_NAME],
            maxIterations: 5,
          },
        ],
      },
      baseContext(),
    );
    // supervisor iter1 trim + iter2 delegate + child 1 iteration = 3 provider calls
    expect(provider.complete).toHaveBeenCalledTimes(3);
    const payload = result.outputs[0]?.payload as {
      trace: Array<{
        toolCall?: { name: string };
        nestedTrace?: { trace: unknown[]; status: string };
      }>;
    };
    const delegateItem = payload.trace.find(
      (t) => t.toolCall?.name === DELEGATION_TOOL_NAME,
    );
    expect(delegateItem?.nestedTrace?.trace).toHaveLength(1);
    expect(delegateItem?.nestedTrace?.status).toBe("iteration_limit_reached");
  });

  it("accurate cumulative token usage across parent and child", async () => {
    const provider = providerDouble([
      {
        text: "delegating",
        toolCalls: [
          {
            id: "sup_1",
            name: DELEGATION_TOOL_NAME,
            arguments: { subAgentId: "researcher", task: "count tokens" },
          },
        ],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        text: "child done",
        usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
      },
      {
        text: "supervisor done",
        usage: { promptTokens: 11, completionTokens: 9, totalTokens: 20 },
      },
    ]);
    const tool = createAgentTool(depsWith(provider));
    const result = await runTool(
      tool,
      textInput("go"),
      {
        ...baseConfig,
        allowedTools: [],
        maxIterations: 5,
        subAgents: [researcherSpec],
      },
      baseContext(),
    );
    expect(result.outputs[0]?.payload).toMatchObject({
      usage: { promptTokens: 28, completionTokens: 17, totalTokens: 45 },
    });
  });
});
