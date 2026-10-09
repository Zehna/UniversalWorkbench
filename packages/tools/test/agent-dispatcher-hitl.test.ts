import type { ContextEnvelope } from "@uw/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  AgentToolDispatcher,
  toToolName,
} from "../src/agent/dispatcher.js";
import { createAgentTool, runTool, createTextTrimTool } from "../src/index.js";
import type { ToolExecutor, ToolRunContext } from "../src/index.js";

const ENVELOPE_ID = "11111111-1111-4111-8111-111111111111";

function baseContext(): ToolRunContext {
  return {
    executionId: "22222222-2222-4222-8222-222222222222",
    stepId: "33333333-3333-4333-8333-333333333333",
    projectId: "44444444-4444-4444-8444-444444444444",
    traceId: "55555555-5555-4555-8555-555555555555",
    signal: new AbortController().signal,
    permissions: new Set(["ai"]),
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

function delayedTool(id: string, delayMs: number, payload: unknown): ToolExecutor {
  const base = createTextTrimTool();
  return {
    descriptor: {
      ...base.descriptor,
      id,
    },
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        outputs: [
          {
            ...textInput(payload),
            id: ENVELOPE_ID,
            payload,
          },
        ],
        usage: { inputBytes: 1, outputBytes: 1 },
      };
    },
  };
}

function approvalGatedTool(id = "builtin.approval.gated"): ToolExecutor {
  const base = createTextTrimTool();
  return {
    descriptor: {
      ...base.descriptor,
      id,
      requiresApproval: true,
    },
    run: async () => {
      return {
        outputs: [textInput("should never run without approval")],
        usage: { inputBytes: 1, outputBytes: 1 },
      };
    },
  };
}

describe("parallel tool dispatch + approval suspension", () => {
  it("executes multiple tool calls concurrently via dispatchMany preserving order", async () => {
    const toolA = delayedTool("builtin.tool.a", 40, "result-a");
    const toolB = delayedTool("builtin.tool.b", 10, "result-b");
    const nameA = toToolName(toolA.descriptor);
    const nameB = toToolName(toolB.descriptor);
    const dispatcher = new AgentToolDispatcher({
      tools: [toolA, toolB],
      allowedTools: [nameA, nameB],
    });

    const startedAt = Date.now();
    const observations = await dispatcher.dispatchMany(
      [
        { id: "call_1", name: nameA, arguments: {} },
        { id: "call_2", name: nameB, arguments: {} },
      ],
      textInput("hi"),
      baseContext(),
    );
    const elapsed = Date.now() - startedAt;

    expect(observations).toHaveLength(2);
    expect(observations[0]?.toolCallId).toBe("call_1");
    expect(observations[1]?.toolCallId).toBe("call_2");
    expect(observations[0]?.isError).toBe(false);
    expect(observations[1]?.isError).toBe(false);
    expect(JSON.stringify(observations[0]?.output)).toContain("result-a");
    expect(JSON.stringify(observations[1]?.output)).toContain("result-b");
    // Parallel: total time well below sequential sum (40+10=50ms + overhead).
    // Allow generous CI slack while still catching sequential execution.
    expect(elapsed).toBeLessThan(70);
  });

  it("flags tool requiring approval without executing it", async () => {
    const gated = approvalGatedTool();
    const runSpy = vi.spyOn(gated, "run");
    const name = toToolName(gated.descriptor);
    const dispatcher = new AgentToolDispatcher({
      tools: [gated],
      allowedTools: [name],
    });

    const observation = await dispatcher.dispatch(
      { id: "call_approval", name, arguments: { foo: "bar" } },
      textInput("hi"),
      baseContext(),
    );

    expect(runSpy).not.toHaveBeenCalled();
    expect(observation.requiresApproval).toBe(true);
    expect(observation.pendingApproval).toMatchObject({ tool: name });
    expect(JSON.stringify(observation.output)).toMatch(/pending|approval/i);
  });

  it("agent loop returns awaiting_approval when encountering approval-gated tool", async () => {
    const gated = approvalGatedTool();
    const runSpy = vi.spyOn(gated, "run");
    const gatedName = toToolName(gated.descriptor);
    const complete = vi.fn(async () => ({
      text: "need approval to proceed",
      model: "test-model",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      usageSource: "provider" as const,
      toolCalls: [{ id: "call_1", name: gatedName, arguments: {} }],
    }));
    const agent = createAgentTool({
      providers: new Map([["test-provider", { id: "test-provider", complete } as never]]),
      resolveSecret: async () => "secret-value",
      tools: [gated as never],
    });

    const result = await runTool(
      agent,
      textInput("hello"),
      {
        providerId: "test-provider",
        model: "test-model",
        prompt: "Answer:",
        secretRef: "secret://vault/openai",
        allowedTools: [gatedName],
      },
      baseContext(),
    );
    const payload = result.outputs[0]?.payload as {
      status: string;
      structured?: { pendingApprovals?: Array<{ tool: string }> };
      trace: unknown[];
    };

    expect(payload.status).toBe("awaiting_approval");
    expect(runSpy).not.toHaveBeenCalled();
    expect(payload.structured?.pendingApprovals?.[0]).toMatchObject({
      tool: gatedName,
    });
  });

  it("ingests rejection feedback as observation when action is rejected", async () => {
    const gated = approvalGatedTool();
    const gatedName = toToolName(gated.descriptor);
    const complete = vi.fn(async (_req: Record<string, unknown>) => {
      if (complete.mock.calls.length === 1) {
        return {
          text: "try gated action",
          model: "test-model",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          usageSource: "provider" as const,
          toolCalls: [{ id: "call_1", name: gatedName, arguments: {} }],
        };
      }
      return {
        text: "chose alternative",
        model: "test-model",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        usageSource: "provider" as const,
      };
    });
    const agent = createAgentTool({
      providers: new Map([["test-provider", { id: "test-provider", complete } as never]]),
      resolveSecret: async () => "secret-value",
      tools: [gated as never],
    });

    const result = await runTool(
      agent,
      textInput("hello"),
      {
        providerId: "test-provider",
        model: "test-model",
        prompt: "Answer:",
        secretRef: "secret://vault/openai",
        allowedTools: [gatedName],
        approvalResolutions: {
          call_1: { decision: "rejected", rejectionReason: "too risky" },
        },
      },
      baseContext(),
    );
    const payload = result.outputs[0]?.payload as {
      status: string;
      text: string;
      trace: Array<{ observation?: { output: unknown } }>;
    };

    expect(payload.status).toBe("completed");
    expect(payload.text).toBe("chose alternative");
    const traceText = JSON.stringify(payload.trace);
    expect(traceText).toMatch(/Action was rejected by user/);
    expect(traceText).toContain("too risky");
  });
});
