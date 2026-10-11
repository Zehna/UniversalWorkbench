import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextEnvelope } from "@uw/contracts";
import {
  createAgentTool,
  createTextTrimTool,
  createToolRegistry,
  DELEGATION_TOOL_NAME,
} from "@uw/tools";
import type { ToolExecutor } from "@uw/tools";
import { createWorkflowEngine } from "../src/engine.js";
import {
  MemoryStore,
  context,
  defaultBudget,
  inputFor,
  workflow,
} from "./fixture.js";

const MULTI_AGENT_CANARY = "golden-multi-agent-canary-3f7a1c9e2b5d";
const RESEARCHER_INSTRUCTIONS = "You are a concise research specialist.";
const TRIM_TOOL_NAME = "builtin.text.trim@1.0.0";
const GATED_TOOL_ID = "builtin.approval.gated";

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
      id: GATED_TOOL_ID,
      version: "1.0.0",
      name: GATED_TOOL_ID,
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

function agentNodeInput(
  subAgents: Array<Record<string, unknown>>,
  allowedTools: string[] = [],
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
      allowedTools,
      maxIterations: 5,
      subAgents,
    },
    input: { source: "workflow_input" as const },
  };
}

function enqueueInput(
  registry: ReturnType<typeof createToolRegistry>,
  agentNode: ReturnType<typeof agentNodeInput>,
  payload: ContextEnvelope,
) {
  const base = inputFor(
    registry,
    workflow([agentNode as never], []),
    payload,
    defaultBudget,
  );
  return { ...base, permissions: new Set(["ai"]) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Phase 9 golden multi-agent end-to-end", () => {
  it("supervisor delegates to specialist -> sub-agent runs scoped tool -> supervisor completes with nested traces and cascaded tokens", async () => {
    const trim = createTextTrimTool();
    let supervisorCalls = 0;
    let childCalls = 0;
    const complete = vi.fn(async (req: Record<string, unknown>) => {
      const prompt = typeof req["prompt"] === "string" ? req["prompt"] : "";
      const isChild = prompt.includes(RESEARCHER_INSTRUCTIONS);
      if (isChild) {
        childCalls += 1;
        if (childCalls === 1) {
          return {
            text: "child needs to trim the input",
            model: "test-model",
            usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
            usageSource: "provider" as const,
            toolCalls: [{ id: "child_1", name: TRIM_TOOL_NAME, arguments: {} }],
          };
        }
        return {
          text: "child result: hello",
          model: "test-model",
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
          usageSource: "provider" as const,
        };
      }
      supervisorCalls += 1;
      if (supervisorCalls === 1) {
        return {
          text: "delegating trim work to specialist",
          model: "test-model",
          usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
          usageSource: "provider" as const,
          toolCalls: [
            {
              id: "sup_1",
              name: DELEGATION_TOOL_NAME,
              arguments: { subAgentId: "researcher", task: "trim this" },
            },
          ],
        };
      }
      return {
        text: "supervisor final: child said hello",
        model: "test-model",
        usage: { promptTokens: 40, completionTokens: 12, totalTokens: 52 },
        usageSource: "provider" as const,
      };
    });

    const agent = createAgentTool({
      providers: new Map([
        ["test-provider", { id: "test-provider", complete } as never],
      ]),
      resolveSecret: async () => MULTI_AGENT_CANARY,
      tools: [trim as never],
    });
    const registry = createToolRegistry();
    registry.register(agent);
    registry.register(trim as never);

    const subAgents = [
      {
        id: "researcher",
        role: "researcher",
        instructions: RESEARCHER_INSTRUCTIONS,
        allowedTools: [TRIM_TOOL_NAME],
        maxIterations: 5,
      },
    ];
    const store = new MemoryStore();
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      enqueueInput(
        registry,
        agentNodeInput(subAgents),
        context("text", "  hello  "),
      ),
    );
    const view = await engine.process(created.id, new AbortController().signal);

    expect(view.execution.status).toBe("completed");
    expect(view.steps).toHaveLength(1);
    expect(view.steps[0]).toMatchObject({
      toolId: "builtin.ai.agent",
      toolVersion: "1.0.0",
    });

    const output = view.steps[0]?.outputContexts[0];
    expect(output?.type).toBe("agent_response");
    const payload = output?.payload as {
      text: string;
      status: string;
      iterations: number;
      trace: Array<{
        iteration: number;
        thought?: string;
        toolCall?: { name: string; arguments: Record<string, unknown> };
        observation?: { output: unknown; isError: boolean };
        nestedTrace?: {
          subAgentId: string;
          role: string;
          trace: Array<{
            iteration: number;
            thought?: string;
            toolCall?: { name: string };
            observation?: { output: unknown; isError: boolean };
          }>;
          status: string;
          usage: {
            promptTokens: number;
            completionTokens: number;
            totalTokens: number;
          };
        };
      }>;
      usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      };
      usageSource: string;
    };

    // Supervisor delegated, sub-agent ran the scoped tool, supervisor finished.
    expect(payload.status).toBe("completed");
    expect(payload.text).toContain("hello");
    expect(payload.iterations).toBe(2);
    expect(complete).toHaveBeenCalledTimes(4);

    const delegateItem = payload.trace.find(
      (item) => item.toolCall?.name === DELEGATION_TOOL_NAME,
    );
    expect(delegateItem).toBeDefined();
    expect(delegateItem?.nestedTrace?.subAgentId).toBe("researcher");
    expect(delegateItem?.nestedTrace?.role).toBe("researcher");
    expect(delegateItem?.nestedTrace?.status).toBe("completed");
    expect(delegateItem?.nestedTrace?.trace).toHaveLength(2);

    const childToolItem = delegateItem?.nestedTrace?.trace.find(
      (item) => item.toolCall?.name === TRIM_TOOL_NAME,
    );
    expect(childToolItem).toBeDefined();
    expect(childToolItem?.observation?.isError).toBe(false);
    expect(JSON.stringify(childToolItem?.observation?.output)).toContain(
      "hello",
    );

    // Cascaded token usage: supervisor turns + child turns accumulate.
    expect(delegateItem?.nestedTrace?.usage).toMatchObject({
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 20,
    });
    expect(payload.usage).toMatchObject({
      promptTokens: 72,
      completionTokens: 30,
      totalTokens: 102,
    });
    expect(payload.usage.totalTokens).toBe(
      payload.usage.promptTokens + payload.usage.completionTokens,
    );
    expect(view.execution.usage).toMatchObject({
      promptTokens: 72,
      completionTokens: 30,
      totalTokens: 102,
    });
    expect(view.receipt).toMatchObject({ status: "completed" });

    // Secret safety: resolved vault plaintext never persists.
    expect(JSON.stringify(view)).not.toContain(MULTI_AGENT_CANARY);
  });

  it("nested HITL golden: sub-agent calls gated tool -> suspends with lineage -> approve resumes -> completes", async () => {
    const gatedRun = vi.fn(async () => ({
      outputs: [{ ...textEnvelope("gated-ok"), payload: "gated-ok" }],
      usage: { inputBytes: 1, outputBytes: 1 },
    }));
    const gated = gatedTool(gatedRun);
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
          text: "child done with gated-ok",
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
        text: "supervisor final with gated-ok",
        model: "test-model",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        usageSource: "provider" as const,
      };
    });

    const agent = createAgentTool({
      providers: new Map([
        ["test-provider", { id: "test-provider", complete } as never],
      ]),
      resolveSecret: async () => MULTI_AGENT_CANARY,
      tools: [gated as never],
    });
    const registry = createToolRegistry();
    registry.register(agent);
    registry.register(gated as never);

    const subAgents = [
      {
        id: "researcher",
        role: "researcher",
        instructions: RESEARCHER_INSTRUCTIONS,
        allowedTools: [gatedName],
        maxIterations: 5,
      },
    ];
    const store = new MemoryStore();
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      enqueueInput(
        registry,
        agentNodeInput(subAgents),
        context("json", { name: "work" }),
      ),
    );

    // Sub-agent calls the gated tool: execution suspends with lineage.
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
    expect(suspendedPayload.status).toBe("awaiting_approval");
    expect(suspendedPayload.structured?.pendingApprovals?.[0]?.tool).toBe(
      gatedName,
    );
    expect(suspendedPayload.structured?.pendingApprovals?.[0]?.subAgentId).toBe(
      "researcher",
    );
    expect(
      suspendedPayload.structured?.pendingApprovals?.[0]?.toolCall,
    ).toMatchObject({ name: gatedName });
    expect(gatedRun).not.toHaveBeenCalled();

    // User approves: sub-agent runs the gated tool, supervisor finishes.
    const resumed = await engine.resolveApproval(created.id, {
      decision: "approved",
    });
    expect(resumed.execution.status).toBe("completed");
    expect(gatedRun).toHaveBeenCalledTimes(1);
    const finalOutput =
      resumed.steps[resumed.steps.length - 1]?.outputContexts[0];
    expect(finalOutput?.type).toBe("agent_response");
    const finalPayload = finalOutput?.payload as {
      status: string;
      text: string;
      trace: Array<{
        toolCall?: { name: string };
        nestedTrace?: {
          subAgentId: string;
          role: string;
          status: string;
          trace: Array<{
            toolCall?: { name: string };
            observation?: { output: unknown; isError: boolean };
          }>;
          usage: { totalTokens: number };
        };
      }>;
      usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      };
    };
    expect(finalPayload.status).toBe("completed");
    expect(finalPayload.text).toContain("gated-ok");
    const delegateItem = finalPayload.trace.find(
      (item) => item.toolCall?.name === DELEGATION_TOOL_NAME,
    );
    expect(delegateItem?.nestedTrace?.subAgentId).toBe("researcher");
    expect(delegateItem?.nestedTrace?.role).toBe("researcher");
    expect(delegateItem?.nestedTrace?.status).toBe("completed");
    expect(
      delegateItem?.nestedTrace?.trace.some(
        (item) => item.toolCall?.name === gatedName,
      ),
    ).toBe(true);
    expect(JSON.stringify(finalPayload)).toContain("gated-ok");
    // Cascaded token usage accumulated across supervisor + approved child run.
    expect(finalPayload.usage.totalTokens).toBe(
      finalPayload.usage.promptTokens + finalPayload.usage.completionTokens,
    );
    expect(finalPayload.usage.totalTokens).toBeGreaterThan(0);
    expect(resumed.receipt).toMatchObject({ status: "completed" });
    expect(JSON.stringify(resumed)).not.toContain(MULTI_AGENT_CANARY);
  });
});
