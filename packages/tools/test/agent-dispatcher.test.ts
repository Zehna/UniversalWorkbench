import type { ContextEnvelope, ToolDescriptor } from "@uw/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  AgentToolDispatcher,
  createAgentToolDispatcher,
  toFunctionCallingSpec,
  toFunctionCallingSpecs,
  toToolName,
} from "../src/agent/dispatcher.js";
import { createTextTrimTool } from "../src/index.js";
import type { ToolExecutor, ToolRunContext } from "../src/index.js";

const envelopeId = "11111111-1111-4111-8111-111111111111";
const runContext: ToolRunContext = {
  executionId: "22222222-2222-4222-8222-222222222222",
  stepId: "33333333-3333-4333-8333-333333333333",
  projectId: "44444444-4444-4444-8444-444444444444",
  traceId: "55555555-5555-4555-8555-555555555555",
  signal: new AbortController().signal,
  permissions: new Set(),
};

function textInput(payload: unknown): ContextEnvelope {
  return {
    id: envelopeId,
    type: "text",
    schemaVersion: 1,
    mimeType: "text/plain",
    metadata: {},
    payload,
    provenance: { sourceContextIds: [] },
    capabilities: [],
  };
}

describe("toFunctionCallingSpec", () => {
  it("converts a ToolDescriptor to provider function calling format", () => {
    const tool = createTextTrimTool();
    const spec = toFunctionCallingSpec(tool.descriptor);

    expect(spec).toEqual({
      name: `${tool.descriptor.id}@${tool.descriptor.version}`,
      description: tool.descriptor.description,
      parameters: tool.descriptor.configSchema,
    });
    expect(spec.name).toBe("builtin.text.trim@1.0.0");
    expect(spec.description).toBe(tool.descriptor.description);
  });

  it("derives the stable tool name from id and version", () => {
    const descriptor = {
      id: "builtin.json.extract",
      version: "2.1.0",
    } as ToolDescriptor;
    expect(toToolName(descriptor)).toBe("builtin.json.extract@2.1.0");
  });

  it("converts a list of descriptors preserving order", () => {
    const a = createTextTrimTool();
    const specs = toFunctionCallingSpecs([a.descriptor, a.descriptor]);
    expect(specs).toHaveLength(2);
    expect(specs[0]?.name).toBe("builtin.text.trim@1.0.0");
  });

  it("does not mutate the source descriptor configSchema", () => {
    const tool = createTextTrimTool();
    const before = JSON.stringify(tool.descriptor.configSchema);
    const spec = toFunctionCallingSpec(tool.descriptor);
    (spec.parameters as Record<string, unknown>).__mutated = true;
    expect(JSON.stringify(tool.descriptor.configSchema)).toBe(before);
  });
});

describe("AgentToolDispatcher", () => {
  it("executes an authorized tool and returns an observation", async () => {
    const tool = createTextTrimTool();
    const name = toToolName(tool.descriptor);
    const dispatcher = new AgentToolDispatcher({
      tools: [tool],
      allowedTools: [name],
    });

    const observation = await dispatcher.dispatch(
      { id: "call_1", name, arguments: {} },
      textInput("  hello  "),
      runContext,
    );

    expect(observation.isError).toBe(false);
    expect(observation.toolCallId).toBe("call_1");
    expect(typeof observation.durationMs).toBe("number");
    expect(observation.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(observation.durationMs)).toBe(true);
    const output = observation.output as {
      outputs: Array<{ payload: unknown }>;
    };
    expect(output.outputs[0]?.payload).toBe("hello");
  });

  it("supports the createAgentToolDispatcher factory", async () => {
    const tool = createTextTrimTool();
    const name = toToolName(tool.descriptor);
    const dispatcher = createAgentToolDispatcher({
      tools: [tool],
      allowedTools: [name],
    });
    expect(dispatcher).toBeInstanceOf(AgentToolDispatcher);
    const specs = dispatcher.listSpecs();
    expect(specs.map((s) => s.name)).toEqual([name]);
  });

  it("rejects a tool that is not in the whitelist (fail-closed)", async () => {
    const allowed = createTextTrimTool();
    const allowedName = toToolName(allowed.descriptor);
    const blocked = createTextTrimTool();
    blocked.descriptor = {
      ...blocked.descriptor,
      id: "builtin.evil.tool",
    };
    const runSpy = vi.spyOn(blocked, "run");
    const dispatcher = new AgentToolDispatcher({
      tools: [allowed, blocked],
      allowedTools: [allowedName],
    });

    const observation = await dispatcher.dispatch(
      { id: "call_evil", name: "builtin.evil.tool@1.0.0", arguments: {} },
      textInput("  hi  "),
      runContext,
    );

    expect(observation.isError).toBe(true);
    expect(observation.toolCallId).toBe("call_evil");
    expect(typeof observation.durationMs).toBe("number");
    expect(observation.output).toMatchObject({
      error: expect.objectContaining({ code: "UNAUTHORIZED_TOOL" }),
    });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("rejects an unknown tool name that was never registered (fail-closed)", async () => {
    const tool = createTextTrimTool();
    const dispatcher = new AgentToolDispatcher({
      tools: [tool],
      allowedTools: [toToolName(tool.descriptor)],
    });

    const observation = await dispatcher.dispatch(
      { id: "call_missing", name: "builtin.missing@9.9.9", arguments: {} },
      textInput("hi"),
      runContext,
    );

    expect(observation.isError).toBe(true);
    expect(observation.output).toMatchObject({
      error: expect.objectContaining({ code: "UNAUTHORIZED_TOOL" }),
    });
  });

  it("returns UNKNOWN_TOOL when whitelisted but not registered", async () => {
    const tool = createTextTrimTool();
    const dispatcher = new AgentToolDispatcher({
      tools: [],
      allowedTools: [toToolName(tool.descriptor)],
    });

    const observation = await dispatcher.dispatch(
      { name: toToolName(tool.descriptor), arguments: {} },
      textInput("hi"),
      runContext,
    );

    expect(observation.isError).toBe(true);
    expect(observation.output).toMatchObject({
      error: expect.objectContaining({ code: "UNKNOWN_TOOL" }),
    });
  });

  it("captures tool execution failures as error observations instead of throwing", async () => {
    const failing: ToolExecutor = {
      descriptor: {
        ...createTextTrimTool().descriptor,
        id: "builtin.always.fails",
      },
      run: async () => {
        throw new Error("boom");
      },
    };
    const name = toToolName(failing.descriptor);
    const dispatcher = new AgentToolDispatcher({
      tools: [failing],
      allowedTools: [name],
    });

    const observation = await dispatcher.dispatch(
      { id: "call_fail", name, arguments: {} },
      textInput("hi"),
      runContext,
    );

    expect(observation.isError).toBe(true);
    expect(observation.toolCallId).toBe("call_fail");
    expect(observation.output).toMatchObject({
      error: expect.objectContaining({
        code: "TOOL_EXECUTION_FAILED",
        tool: name,
      }),
    });
    const output = observation.output as {
      error: { message: string };
    };
    expect(output.error.message).toMatch(/boom/);
  });

  it("captures tool validation errors (e.g. wrong input type) as error observations", async () => {
    const tool = createTextTrimTool();
    const name = toToolName(tool.descriptor);
    const dispatcher = new AgentToolDispatcher({
      tools: [tool],
      allowedTools: [name],
    });
    const badInput: ContextEnvelope = {
      ...textInput({ not: "a string" }),
      type: "json",
      mimeType: "application/json",
    };

    const observation = await dispatcher.dispatch(
      { name, arguments: {} },
      badInput,
      runContext,
    );

    expect(observation.isError).toBe(true);
    expect(typeof observation.durationMs).toBe("number");
  });

  it("defaults missing arguments to an empty config object", async () => {
    const tool = createTextTrimTool();
    const name = toToolName(tool.descriptor);
    const dispatcher = new AgentToolDispatcher({
      tools: [tool],
      allowedTools: [name],
    });

    const observation = await dispatcher.dispatch(
      { name },
      textInput("  spaced  "),
      runContext,
    );

    expect(observation.isError).toBe(false);
    const output = observation.output as {
      outputs: Array<{ payload: unknown }>;
    };
    expect(output.outputs[0]?.payload).toBe("spaced");
  });
});
