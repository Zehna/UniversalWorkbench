import { describe, expect, it, vi } from "vitest";
import type { ContextEnvelope } from "@uw/contracts";
import { createAgentTool } from "@uw/tools";
import { createToolRegistry } from "@uw/tools";
import type { ToolExecutor } from "@uw/tools";
import { DELEGATION_TOOL_NAME } from "@uw/tools";
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

const RESEARCHER_INSTRUCTIONS = "You are a concise research specialist.";

function nestedAgentSetup(options: {
  gatedRun?: ToolExecutor["run"];
  childFinalText?: string;
  supervisorFinalText?: string;
}) {
  const gated = gatedTool(options.gatedRun);
  const gatedName = `${gated.descriptor.id}@${gated.descriptor.version}`;
  let supervisorCalls = 0;
  let childCalls = 0;
  const complete = vi.fn(async (req: Record<string, unknown>) => {
    const prompt = typeof req["prompt"] === "string" ? req["prompt"] : "";
    const isChild = prompt.includes(RESEARCHER_INSTRUCTIONS);
    if (isChild) {
      childCalls += 1;
      if (childCalls <= 2) {
        return {
          text: "child needs gated tool",
          model: "test-model",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          usageSource: "provider" as const,
          toolCalls: [{ id: "child_1", name: gatedName, arguments: {} }],
        };
      }
      return {
        text: options.childFinalText ?? "child done",
        model: "test-model",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        usageSource: "provider" as const,
      };
    }
    supervisorCalls += 1;
    if (supervisorCalls <= 2) {
      return {
        text: "delegating to researcher",
        model: "test-model",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        usageSource: "provider" as const,
        toolCalls: [
          {
            id: "sup_1",
            name: DELEGATION_TOOL_NAME,
            arguments: { subAgentId: "researcher", task: "do research" },
          },
        ],
      };
    }
    return {
      text: options.supervisorFinalText ?? "supervisor final",
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
  agentConfigExtra: Record<string, unknown> = {},
  gatedName: string,
) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    toolId: "builtin.ai.agent",
    toolVersion: "1.0.0",
    config: {
      providerId: "test-provider",
      model: "test-model",
      prompt: "You are a supervisor. Delegate research when needed.",
      secretRef: "secret://vault/openai",
      allowedTools: [],
      maxIterations: 5,
      subAgents: [
        {
          id: "researcher",
          role: "researcher",
          instructions: RESEARCHER_INSTRUCTIONS,
          allowedTools: [gatedName],
          maxIterations: 5,
        },
      ],
      ...agentConfigExtra,
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

describe("Nested HITL approval propagation", () => {
  it("suspends at awaiting_approval when sub-agent invokes a gated tool", async () => {
    const { registry, gatedName } = nestedAgentSetup({});
    const store = new MemoryStore();
    const engine = createWorkflowEngine({ store, registry });
    const agentNode = agentNodeInput({}, gatedName);
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

  it("includes sub-agent lineage in pending approval details", async () => {
    const { registry, gatedName } = nestedAgentSetup({});
    const store = new MemoryStore();
    const engine = createWorkflowEngine({ store, registry });
    const agentNode = agentNodeInput({}, gatedName);
    const created = await engine.enqueue(enqueueInput(registry, agentNode));
    const view = await engine.process(created.id, new AbortController().signal);
    const output = view.steps[0]?.outputContexts[0];
    const payload = output?.payload as {
      structured?: {
        pendingApprovals?: Array<{
          tool: string;
          toolCallId?: string;
          subAgentId?: string;
          role?: string;
          toolCall?: { name: string };
        }>;
      };
    };
    const pending = payload.structured?.pendingApprovals?.[0];
    expect(pending?.subAgentId).toBe("researcher");
    expect(pending?.toolCall).toMatchObject({ name: gatedName });
  });

  it("approving resumes child, runs gated tool, and completes the workflow", async () => {
    const gatedRun = vi.fn(async () => ({
      outputs: [{ ...textEnvelope("gated-ok"), payload: "gated-ok" }],
      usage: { inputBytes: 1, outputBytes: 1 },
    }));
    const { registry, gatedName } = nestedAgentSetup({
      gatedRun,
      childFinalText: "child done with gated-ok",
      supervisorFinalText: "supervisor final with gated-ok",
    });
    const store = new MemoryStore();
    const engine = createWorkflowEngine({ store, registry });
    const agentNode = agentNodeInput({}, gatedName);
    const created = await engine.enqueue(enqueueInput(registry, agentNode));
    const suspended = await engine.process(
      created.id,
      new AbortController().signal,
    );
    expect(suspended.execution.status).toBe("awaiting_approval");
    const resumed = await engine.resolveApproval(created.id, {
      decision: "approved",
    });
    expect(resumed.execution.status).toBe("completed");
    expect(gatedRun).toHaveBeenCalled();
    const finalOutput =
      resumed.steps[resumed.steps.length - 1]?.outputContexts[0];
    expect(finalOutput?.type).toBe("agent_response");
    const payload = finalOutput?.payload as {
      status: string;
      text: string;
      trace: Array<{
        toolCall?: { name: string };
        nestedTrace?: { subAgentId: string; status: string };
      }>;
    };
    expect(payload.status).toBe("completed");
    const delegateItem = payload.trace.find(
      (t) => t.toolCall?.name === DELEGATION_TOOL_NAME,
    );
    expect(delegateItem?.nestedTrace?.subAgentId).toBe("researcher");
    expect(delegateItem?.nestedTrace?.status).toBe("completed");
    expect(JSON.stringify(payload)).toContain("gated-ok");
  });

  it("rejecting injects feedback into child which adapts without running gated tool", async () => {
    const gatedRun = vi.fn(async () => ({
      outputs: [
        { ...textEnvelope("should not run"), payload: "should not run" },
      ],
      usage: { inputBytes: 1, outputBytes: 1 },
    }));
    const { registry, gatedName } = nestedAgentSetup({
      gatedRun,
      childFinalText: "child chose alternative",
      supervisorFinalText: "supervisor final alternative",
    });
    const store = new MemoryStore();
    const engine = createWorkflowEngine({ store, registry });
    const agentNode = agentNodeInput({}, gatedName);
    const created = await engine.enqueue(enqueueInput(registry, agentNode));
    await engine.process(created.id, new AbortController().signal);
    const resumed = await engine.resolveApproval(created.id, {
      decision: "rejected",
      rejectionReason: "too risky",
    });
    expect(resumed.execution.status).toBe("completed");
    expect(gatedRun).not.toHaveBeenCalled();
    const serialized = JSON.stringify(resumed);
    expect(serialized).toMatch(/Action was rejected by user/);
    expect(serialized).toContain("too risky");
  });
});
