import { describe, expect, it, vi } from "vitest";
import type { ContextEnvelope } from "@uw/contracts";
import { createAgentTool } from "@uw/tools";
import { createToolRegistry } from "@uw/tools";
import type { ToolExecutor } from "@uw/tools";
import { createWorkflowEngine } from "../src/engine.js";
import {
  MemoryStore,
  context,
  defaultBudget,
  inputFor,
  workflow,
} from "./fixture.js";

function textEnvelope(payload: unknown): ContextEnvelope {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    type: "text",
    schemaVersion: 1,
    mimeType: "text/plain",
    metadata: {},
    payload,
    provenance: { sourceContextIds: [] },
    capabilities: [],
  };
}

function gatedTool(runImpl?: ToolExecutor["run"]): ToolExecutor {
  const baseId = "builtin.approval.gated";
  return {
    descriptor: {
      id: baseId,
      version: "1.0.0",
      name: baseId,
      description: "Gated tool",
      accepts: ["text", "json", "markdown"],
      produces: ["text"],
      permissions: [],
      capabilities: [],
      executionMode: "server",
      idempotency: "safe",
      configSchema: {},
      requiresApproval: true,
    } as unknown as ToolExecutor["descriptor"],
    run:
      runImpl ??
      (async () => ({
        outputs: [{ ...textEnvelope("gated-result"), payload: "gated-result" }],
        usage: { inputBytes: 1, outputBytes: 1 },
      })),
  };
}

function agentSetup(options: {
  gatedRun?: ToolExecutor["run"];
  providerTexts?: { finalText?: string };
}) {
  const gated = gatedTool(options.gatedRun);
  const gatedName = `${gated.descriptor.id}@${gated.descriptor.version}`;
  const complete = vi.fn(async () => {
    const callIndex = complete.mock.calls.length;
    if (callIndex <= 2) {
      return {
        text: "need approval to proceed",
        model: "test-model",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        usageSource: "provider" as const,
        toolCalls: [{ id: "call_1", name: gatedName, arguments: {} }],
      };
    }
    return {
      text: options.providerTexts?.finalText ?? "agent final answer",
      model: "test-model",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      usageSource: "provider" as const,
    };
  });
  const agent = createAgentTool({
    providers: new Map([
      ["test-provider", { id: "test-provider", complete } as never],
    ]),
    resolveSecret: async () => "secret-value",
    tools: [gated as never],
  });
  const registry = createToolRegistry();
  registry.register(agent);
  registry.register(gated as never);
  return { agent, gated, gatedName, registry, complete };
}

function agentNodeInput(
  _registry: ReturnType<typeof createToolRegistry>,
  agentConfigExtra: Record<string, unknown> = {},
) {
  const agentNode = {
    id: "00000000-0000-4000-8000-000000000001",
    toolId: "builtin.ai.agent",
    toolVersion: "1.0.0",
    config: {
      providerId: "test-provider",
      model: "test-model",
      prompt: "Answer:",
      secretRef: "secret://vault/openai",
      ...agentConfigExtra,
    },
    input: { source: "workflow_input" as const },
  };
  return agentNode;
}

function enqueueInput(
  registry: ReturnType<typeof createToolRegistry>,
  agentNode: ReturnType<typeof agentNodeInput>,
) {
  const base = inputFor(
    registry,
    workflow([agentNode as never], []),
    context("json", { name: "work" }),
    defaultBudget,
  );
  return { ...base, permissions: new Set(["ai"]) };
}

describe("HITL engine suspend/resume", () => {
  it("transitions to awaiting_approval when an agent node encounters a gated tool", async () => {
    const { registry, gatedName } = agentSetup({});
    const store = new MemoryStore();
    const engine = createWorkflowEngine({ store, registry });
    const agentNode = agentNodeInput(registry, { allowedTools: [gatedName] });
    const created = await engine.enqueue(enqueueInput(registry, agentNode));
    const view = await engine.process(created.id, new AbortController().signal);
    expect(view.execution.status).toBe("awaiting_approval");
    expect(view.steps).toHaveLength(1);
    expect(view.steps[0]?.status).toBe("awaiting_approval");
    const output = view.steps[0]?.outputContexts[0];
    expect(output?.type).toBe("agent_response");
    const payload = output?.payload as {
      status: string;
      structured?: { pendingApprovals?: Array<{ tool: string }> };
    };
    expect(payload.status).toBe("awaiting_approval");
    expect(payload.structured?.pendingApprovals?.[0]?.tool).toBe(gatedName);
  });

  it("resuming with approved executes the tool and finishes as completed", async () => {
    const gatedRun = vi.fn(async () => ({
      outputs: [{ ...textEnvelope("gated-ok"), payload: "gated-ok" }],
      usage: { inputBytes: 1, outputBytes: 1 },
    }));
    const { registry, gatedName } = agentSetup({ gatedRun });
    const store = new MemoryStore();
    const engine = createWorkflowEngine({ store, registry });
    const agentNode = agentNodeInput(registry, { allowedTools: [gatedName] });
    const created = await engine.enqueue(enqueueInput(registry, agentNode));
    const suspended = await engine.process(
      created.id,
      new AbortController().signal,
    );
    expect(suspended.execution.status).toBe("awaiting_approval");
    const resumed = await (
      engine as never as {
        resolveApproval: (
          id: string,
          r: { decision: "approved" },
        ) => Promise<typeof suspended>;
      }
    ).resolveApproval(created.id, { decision: "approved" });
    expect(resumed.execution.status).toBe("completed");
    expect(gatedRun).toHaveBeenCalled();
    const finalOutput =
      resumed.steps[resumed.steps.length - 1]?.outputContexts[0];
    expect(finalOutput?.type).toBe("agent_response");
    expect((finalOutput?.payload as { status: string }).status).toBe(
      "completed",
    );
  });

  it("resuming with rejected passes feedback into the agent which completes alternatively", async () => {
    const gatedRun = vi.fn(async () => ({
      outputs: [
        { ...textEnvelope("should not run"), payload: "should not run" },
      ],
      usage: { inputBytes: 1, outputBytes: 1 },
    }));
    const { registry, gatedName } = agentSetup({
      gatedRun,
      providerTexts: { finalText: "chose alternative" },
    });
    const store = new MemoryStore();
    const engine = createWorkflowEngine({ store, registry });
    const agentNode = agentNodeInput(registry, { allowedTools: [gatedName] });
    const created = await engine.enqueue(enqueueInput(registry, agentNode));
    await engine.process(created.id, new AbortController().signal);
    const resumed = await (
      engine as never as {
        resolveApproval: (
          id: string,
          r: { decision: "rejected"; rejectionReason?: string },
        ) => Promise<
          { execution: { status: string }; steps: unknown[] } & Record<
            string,
            unknown
          >
        >;
      }
    ).resolveApproval(created.id, {
      decision: "rejected",
      rejectionReason: "too risky",
    });
    expect(
      (resumed as unknown as { execution: { status: string } }).execution
        .status,
    ).toBe("completed");
    expect(gatedRun).not.toHaveBeenCalled();
    const serialized = JSON.stringify(resumed);
    expect(serialized).toMatch(/Action was rejected by user/);
    expect(serialized).toContain("too risky");
  });

  it("rejects approve/reject when execution is not awaiting_approval", async () => {
    const { registry, gatedName } = agentSetup({});
    const store = new MemoryStore();
    const engine = createWorkflowEngine({ store, registry });
    const agentNode = agentNodeInput(registry, { allowedTools: [gatedName] });
    const created = await engine.enqueue(enqueueInput(registry, agentNode));
    await expect(
      (
        engine as never as {
          resolveApproval: (id: string, r: unknown) => Promise<unknown>;
        }
      ).resolveApproval(created.id, { decision: "approved" }),
    ).rejects.toThrow();
    const suspended = await engine.process(
      created.id,
      new AbortController().signal,
    );
    expect(suspended.execution.status).toBe("awaiting_approval");
    await (
      engine as never as {
        resolveApproval: (id: string, r: unknown) => Promise<unknown>;
      }
    ).resolveApproval(created.id, { decision: "approved" });
    await expect(
      (
        engine as never as {
          resolveApproval: (id: string, r: unknown) => Promise<unknown>;
        }
      ).resolveApproval(created.id, { decision: "rejected" }),
    ).rejects.toThrow();
  });
});
