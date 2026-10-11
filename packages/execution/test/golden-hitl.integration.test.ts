import { describe, expect, it, vi } from "vitest";
import type { ContextEnvelope } from "@uw/contracts";
import { createAgentTool, createToolRegistry } from "@uw/tools";
import type { ToolExecutor } from "@uw/tools";
import { createWorkflowEngine } from "../src/engine.js";
import {
  MemoryStore,
  context,
  defaultBudget,
  inputFor,
  workflow,
} from "./fixture.js";

const HITL_CANARY = "golden-hitl-canary-9d3b7a1c4e5f";

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
  return {
    descriptor: {
      id: "builtin.approval.gated",
      version: "1.0.0",
      name: "builtin.approval.gated",
      description: "Gated tool requiring human approval",
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
  finalText?: string;
}) {
  const gated = gatedTool(options.gatedRun);
  const gatedName = `${gated.descriptor.id}@${gated.descriptor.version}`;
  // First two provider turns request the gated tool (suspend, then resume
  // with the approval resolution applied); third turn answers final.
  const complete = vi.fn(async () => {
    const callIndex = complete.mock.calls.length;
    if (callIndex <= 2) {
      return {
        text: "need approval to proceed",
        model: "test-model",
        usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
        usageSource: "provider" as const,
        toolCalls: [{ id: "call_1", name: gatedName, arguments: {} }],
      };
    }
    return {
      text: options.finalText ?? "agent final answer",
      model: "test-model",
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
      usageSource: "provider" as const,
    };
  });
  const agent = createAgentTool({
    providers: new Map([
      ["test-provider", { id: "test-provider", complete } as never],
    ]),
    resolveSecret: async () => HITL_CANARY,
    tools: [gated as never],
  });
  const registry = createToolRegistry();
  registry.register(agent);
  registry.register(gated as never);
  return { agent, gated, gatedName, registry, complete };
}

function agentNodeInput(gatedName: string) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    toolId: "builtin.ai.agent",
    toolVersion: "1.0.0",
    config: {
      providerId: "test-provider",
      model: "test-model",
      prompt: "Answer:",
      secretRef: "secret://vault/openai",
      allowedTools: [gatedName],
    },
    input: { source: "workflow_input" as const },
  };
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

describe("Phase 7 golden HITL end-to-end", () => {
  it("approval flow: agent -> awaiting_approval -> approve -> tool runs -> completed", async () => {
    const gatedRun = vi.fn(async () => ({
      outputs: [{ ...textEnvelope("gated-ok"), payload: "gated-ok" }],
      usage: { inputBytes: 1, outputBytes: 1 },
    }));
    const { registry, gatedName } = agentSetup({ gatedRun });
    const store = new MemoryStore();
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      enqueueInput(registry, agentNodeInput(gatedName)),
    );

    // Agent calls the gated tool: execution suspends at awaiting_approval.
    const suspended = await engine.process(
      created.id,
      new AbortController().signal,
    );
    expect(suspended.execution.status).toBe("awaiting_approval");
    expect(suspended.steps).toHaveLength(1);
    expect(suspended.steps[0]?.status).toBe("awaiting_approval");
    const suspendedOutput = suspended.steps[0]?.outputContexts[0];
    expect(suspendedOutput?.type).toBe("agent_response");
    const suspendedPayload = suspendedOutput?.payload as {
      status: string;
      structured?: { pendingApprovals?: Array<{ tool: string; toolCallId?: string }> };
    };
    expect(suspendedPayload.status).toBe("awaiting_approval");
    expect(suspendedPayload.structured?.pendingApprovals?.[0]?.tool).toBe(
      gatedName,
    );
    expect(gatedRun).not.toHaveBeenCalled();

    // User approves: execution resumes, runs the gated tool, and completes.
    const resumed = await engine.resolveApproval(created.id, {
      decision: "approved",
    });
    expect(resumed.execution.status).toBe("completed");
    expect(gatedRun).toHaveBeenCalledTimes(1);
    const finalOutput = resumed.steps[resumed.steps.length - 1]?.outputContexts[0];
    expect(finalOutput?.type).toBe("agent_response");
    expect((finalOutput?.payload as { status: string }).status).toBe(
      "completed",
    );
    expect(resumed.receipt).toMatchObject({ status: "completed" });
    // Secret safety: resolved vault plaintext never persists in views/receipts.
    expect(JSON.stringify(resumed)).not.toContain(HITL_CANARY);
  });

  it("rejection flow: agent -> suspends -> reject with reason -> completes without running gated tool", async () => {
    const gatedRun = vi.fn(async () => ({
      outputs: [{ ...textEnvelope("must not run"), payload: "must not run" }],
      usage: { inputBytes: 1, outputBytes: 1 },
    }));
    const { registry, gatedName } = agentSetup({
      gatedRun,
      finalText: "chose safe alternative",
    });
    const store = new MemoryStore();
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      enqueueInput(registry, agentNodeInput(gatedName)),
    );

    const suspended = await engine.process(
      created.id,
      new AbortController().signal,
    );
    expect(suspended.execution.status).toBe("awaiting_approval");

    const resumed = await engine.resolveApproval(created.id, {
      decision: "rejected",
      rejectionReason: "too risky for production",
    });
    expect(resumed.execution.status).toBe("completed");
    // Gated tool never ran; rejection observation was fed back into the agent.
    expect(gatedRun).not.toHaveBeenCalled();
    const serialized = JSON.stringify(resumed);
    expect(serialized).toMatch(/Action was rejected by user/);
    expect(serialized).toContain("too risky for production");
    expect(JSON.stringify(resumed)).not.toContain(HITL_CANARY);
  });
});
