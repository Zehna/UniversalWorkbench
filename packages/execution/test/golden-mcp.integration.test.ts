import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentTool,
  createToolRegistry,
  InMemoryMcpTransport,
  McpClient,
  registerMcpTools,
  type McpToolDefinition,
} from "@uw/tools";
import { createWorkflowEngine } from "../src/engine.js";
import {
  MemoryStore,
  context,
  defaultBudget,
  inputFor,
  node,
  workflow,
} from "./fixture.js";

const MCP_CANARY = "golden-mcp-canary-7f2a9c1d4e5b";
const SERVER_ID = "golden";
const MCP_TOOL_NAME = "mcp.golden.lookup@1.0.0";

const lookupTool: McpToolDefinition = {
  name: "lookup",
  description: "Look up fixture records from the mock MCP server",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

interface ProviderStep {
  text: string;
  toolCalls?: Array<{
    id?: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

function agentProviderDouble(steps: ProviderStep[]) {
  const complete = vi.fn(async () => {
    const callIndex = complete.mock.calls.length - 1;
    const step: ProviderStep = steps[
      Math.min(callIndex, Math.max(0, steps.length - 1))
    ] ?? { text: "" };
    const usage = step.usage ?? {
      promptTokens: 7,
      completionTokens: 9,
      totalTokens: 16,
    };
    return {
      text: step.text,
      model: "atlas",
      usage: { ...usage },
      usageSource: "provider" as const,
      ...(step.toolCalls !== undefined ? { toolCalls: step.toolCalls } : {}),
    };
  });
  return { id: "mock", complete };
}

async function mcpAgentSetup(options: {
  requiresApproval?: boolean;
  toolText?: string;
  finalText?: string;
}) {
  const toolText = options.toolText ?? '{"answer":42,"city":"Paris"}';
  const transport = new InMemoryMcpTransport([lookupTool], {
    lookup: { content: [{ type: "text", text: toolText }] },
  });
  const client = new McpClient(transport);
  await client.connect();
  const discovered = await client.listTools();

  const registry = createToolRegistry();
  const descriptors = registerMcpTools(
    registry,
    SERVER_ID,
    discovered,
    client,
    {
      ...(options.requiresApproval === true ? { requiresApproval: true } : {}),
    },
  );
  const mcpName = `${descriptors[0]?.id}@${descriptors[0]?.version}`;
  const executors = registry
    .list()
    .map((descriptor) => registry.resolve(descriptor.id, descriptor.version));

  return { transport, client, registry, descriptors, mcpName, executors };
}

function agentNodeConfig(mcpName: string, prompt: string) {
  return {
    providerId: "mock",
    model: "atlas",
    prompt,
    secretRef: "secret://vault/golden-mcp",
    allowedTools: [mcpName],
    maxIterations: 5,
  };
}

describe("Phase 8 golden MCP end-to-end", () => {
  it("ReAct over mock MCP: agent calls dynamic MCP tool -> observes output -> completes cleanly", async () => {
    const { client, registry, descriptors, mcpName } = await mcpAgentSetup({});
    expect(mcpName).toBe(MCP_TOOL_NAME);
    expect(descriptors[0]).toMatchObject({
      id: "mcp.golden.lookup",
      version: "1.0.0",
      requiresApproval: false,
    });
    expect(descriptors[0]?.accepts).toEqual(
      expect.arrayContaining(["json", "text"]),
    );
    expect(descriptors[0]?.produces).toEqual(
      expect.arrayContaining(["json", "text"]),
    );
    expect(descriptors[0]?.capabilities).toContain("mcp");

    const provider = agentProviderDouble([
      {
        text: "I need to look up the fixture first",
        toolCalls: [
          {
            id: "call_1",
            name: mcpName,
            arguments: { query: "Paris" },
          },
        ],
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      },
      {
        text: "The answer is 42 in Paris.",
        usage: { promptTokens: 40, completionTokens: 12, totalTokens: 52 },
      },
    ]);
    const executors = registry
      .list()
      .map((descriptor) => registry.resolve(descriptor.id, descriptor.version));
    const agent = createAgentTool({
      providers: new Map([["mock", provider as never]]),
      resolveSecret: async () => MCP_CANARY,
      tools: executors as never[],
    });
    registry.register(agent);

    const callSpy = vi.spyOn(client, "callTool");
    const agentNode = node(1, agent.descriptor.id, undefined, {
      config: agentNodeConfig(
        mcpName,
        "Answer the question using the available tools:",
      ),
    });
    const definition = workflow([agentNode], []);
    const store = new MemoryStore();
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue({
      ...inputFor(
        registry,
        definition,
        context("json", { query: "Paris" }),
        defaultBudget,
      ),
      permissions: new Set(["ai"]),
    });
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
      }>;
      usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      };
    };
    expect(payload.text).toContain("42");
    expect(payload.text).toContain("Paris");
    expect(payload.status).toBe("completed");
    expect(payload.iterations).toBe(2);
    expect(provider.complete).toHaveBeenCalledTimes(2);

    expect(payload.trace).toHaveLength(2);
    expect(payload.trace[0]?.toolCall?.name).toBe(mcpName);
    expect(payload.trace[0]?.observation?.isError).toBe(false);
    expect(JSON.stringify(payload.trace[0]?.observation?.output)).toContain(
      "42",
    );
    expect(typeof payload.trace[1]?.thought).toBe("string");

    expect(callSpy).toHaveBeenCalledTimes(1);
    // The MCP bridge derives transport args from the agent input envelope
    // (extractMcpArgs), not from the provider's per-call arguments: the
    // workflow input above carries { query: "Paris" }, so the transport must
    // have received exactly that. Per-step parameterization is a known
    // future-work gap (see docs/architecture/phase-8.md §3).
    expect(callSpy).toHaveBeenCalledWith(
      "lookup",
      expect.objectContaining({ query: "Paris" }),
    );
    expect(payload.usage).toMatchObject({
      promptTokens: 60,
      completionTokens: 22,
      totalTokens: 82,
    });
    expect(view.execution.usage).toMatchObject({
      promptTokens: 60,
      completionTokens: 22,
      totalTokens: 82,
    });
    expect(view.receipt).toMatchObject({ status: "completed" });

    expect(JSON.stringify(view)).not.toContain(MCP_CANARY);
    await client.close();
  });

  it("HITL over dynamic MCP tool: requiresApproval suspends -> approve resumes -> completes", async () => {
    const { client, registry, mcpName } = await mcpAgentSetup({
      requiresApproval: true,
    });
    expect(mcpName).toBe(MCP_TOOL_NAME);
    expect(
      registry.resolve("mcp.golden.lookup", "1.0.0").descriptor
        .requiresApproval,
    ).toBe(true);

    const complete = vi.fn(async () => {
      const callIndex = complete.mock.calls.length;
      if (callIndex <= 2) {
        return {
          text: "need approval to look up the fixture",
          model: "test-model",
          usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
          usageSource: "provider" as const,
          toolCalls: [{ id: "call_1", name: mcpName, arguments: {} }],
        };
      }
      return {
        text: "The answer is 42 in Paris.",
        model: "test-model",
        usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
        usageSource: "provider" as const,
      };
    });
    const executors = registry
      .list()
      .map((descriptor) => registry.resolve(descriptor.id, descriptor.version));
    const agent = createAgentTool({
      providers: new Map([
        ["test-provider", { id: "test-provider", complete } as never],
      ]),
      resolveSecret: async () => MCP_CANARY,
      tools: executors as never[],
    });
    registry.register(agent);
    const callSpy = vi.spyOn(client, "callTool");

    const agentNode = {
      id: "00000000-0000-4000-8000-000000000001",
      toolId: "builtin.ai.agent",
      toolVersion: "1.0.0",
      config: {
        providerId: "test-provider",
        model: "test-model",
        prompt: "Answer:",
        secretRef: "secret://vault/openai",
        allowedTools: [mcpName],
      },
      input: { source: "workflow_input" as const },
    };
    const store = new MemoryStore();
    const engine = createWorkflowEngine({ store, registry });
    const base = inputFor(
      registry,
      workflow([agentNode as never], []),
      context("json", { query: "Paris" }),
      defaultBudget,
    );
    const created = await engine.enqueue({
      ...base,
      permissions: new Set(["ai"]),
    });

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
        pendingApprovals?: Array<{ tool: string; toolCallId?: string }>;
      };
    };
    expect(suspendedPayload.status).toBe("awaiting_approval");
    expect(suspendedPayload.structured?.pendingApprovals?.[0]?.tool).toBe(
      mcpName,
    );
    expect(callSpy).not.toHaveBeenCalled();

    const resumed = await engine.resolveApproval(created.id, {
      decision: "approved",
    });
    expect(resumed.execution.status).toBe("completed");
    expect(callSpy).toHaveBeenCalledTimes(1);
    const finalOutput =
      resumed.steps[resumed.steps.length - 1]?.outputContexts[0];
    expect(finalOutput?.type).toBe("agent_response");
    const finalPayload = finalOutput?.payload as {
      status: string;
      text: string;
    };
    expect(finalPayload.status).toBe("completed");
    expect(finalPayload.text).toContain("42");
    expect(resumed.receipt).toMatchObject({ status: "completed" });
    expect(JSON.stringify(resumed)).not.toContain(MCP_CANARY);
    await client.close();
  });
});
