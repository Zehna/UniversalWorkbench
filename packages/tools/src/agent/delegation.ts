import {
  AgentDelegationInputSchema,
  ToolDescriptorSchema,
} from "@uw/contracts";
import type {
  AgentNestedTraceItem,
  AgentStatus,
  AgentTraceItem,
  AiSubAgentSpec,
  AiUsage,
  AiUsageSource,
  ContextEnvelope,
  ToolDescriptor,
} from "@uw/contracts";
import type {
  AgentProviderPort,
  AgentProviderToolDefinition,
} from "../builtin/agent.js";
import { AgentToolDispatcher } from "./dispatcher.js";
import type { ToolExecutor, ToolRunContext } from "../runtime.js";

export const DELEGATION_TOOL_ID = "builtin.agent.delegate";
export const DELEGATION_TOOL_VERSION = "1.0.0";
export const DELEGATION_TOOL_NAME = `${DELEGATION_TOOL_ID}@${DELEGATION_TOOL_VERSION}`;

export interface DelegationSupervisorContext {
  provider: AgentProviderPort;
  secretValue: string;
  tools: ToolExecutor[];
  input: ContextEnvelope;
  context: ToolRunContext;
  model: string;
  systemPrompt?: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface DelegationInput {
  task: string;
  context?: unknown;
}

export interface DelegationOptions {
  remainingSupervisorIterations: number;
}

export interface SubAgentDelegationResult {
  text: string;
  model: string;
  status: AgentStatus;
  iterations: number;
  trace: AgentTraceItem[];
  usage: AiUsage;
  usageSource: AiUsageSource;
  nestedTrace: AgentNestedTraceItem;
}

function toSafeArguments(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function createDelegationToolDescriptor(): ToolDescriptor {
  return ToolDescriptorSchema.parse({
    id: DELEGATION_TOOL_ID,
    version: DELEGATION_TOOL_VERSION,
    name: "Agent Delegate",
    description:
      "Delegate a sub-task to a specialist sub-agent with scoped tools",
    accepts: ["text", "json"],
    produces: ["text", "json"],
    permissions: ["ai"],
    capabilities: ["tool-calling", "delegation"],
    executionMode: "server",
    idempotency: "keyed",
    configSchema: {
      type: "object",
      properties: {
        subAgentId: { type: "string", description: "Sub-agent identifier" },
        task: { type: "string", description: "Task for the sub-agent" },
        context: { description: "Optional additional context" },
      },
      required: ["subAgentId", "task"],
      additionalProperties: true,
    },
  });
}

export function toDelegationFunctionSpec(): AgentProviderToolDefinition {
  const descriptor = createDelegationToolDescriptor();
  return {
    name: DELEGATION_TOOL_NAME,
    description: descriptor.description,
    parameters: {
      ...(descriptor.configSchema as Record<string, unknown>),
    },
  };
}

export function createDelegationToolDescriptorForTest(): ToolDescriptor {
  return createDelegationToolDescriptor();
}

export async function runSubAgentDelegation(
  supervisorContext: DelegationSupervisorContext,
  subAgentSpec: AiSubAgentSpec,
  input: DelegationInput,
  options: DelegationOptions,
): Promise<SubAgentDelegationResult> {
  const parsedInput = AgentDelegationInputSchema.safeParse({
    subAgentId: subAgentSpec.id,
    task: input.task,
    ...(input.context !== undefined ? { context: input.context } : {}),
  });
  if (!parsedInput.success) {
    const emptyUsage: AiUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const emptyTrace: AgentTraceItem[] = [];
    return {
      text: "",
      model: supervisorContext.model,
      status: "error",
      iterations: 0,
      trace: emptyTrace,
      usage: emptyUsage,
      usageSource: "estimated",
      nestedTrace: {
        subAgentId: subAgentSpec.id,
        role: subAgentSpec.role,
        trace: emptyTrace,
        status: "error",
        usage: emptyUsage,
      },
    };
  }

  const remaining = options.remainingSupervisorIterations;
  if (!Number.isFinite(remaining) || remaining < 1) {
    const emptyUsage: AiUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const emptyTrace: AgentTraceItem[] = [];
    return {
      text: "",
      model: supervisorContext.model,
      status: "iteration_limit_reached",
      iterations: 0,
      trace: emptyTrace,
      usage: emptyUsage,
      usageSource: "provider",
      nestedTrace: {
        subAgentId: subAgentSpec.id,
        role: subAgentSpec.role,
        trace: emptyTrace,
        status: "iteration_limit_reached",
        usage: emptyUsage,
      },
    };
  }

  const specMax = subAgentSpec.maxIterations ?? 5;
  const effectiveMax = Math.max(1, Math.min(specMax, Math.floor(remaining)));

  const dispatcher = new AgentToolDispatcher({
    tools: supervisorContext.tools ?? [],
    allowedTools: subAgentSpec.allowedTools ?? [],
  });
  const toolDefs: AgentProviderToolDefinition[] = dispatcher
    .listSpecs()
    .map((spec) => ({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
    }));

  const maxOutputTokens =
    subAgentSpec.maxOutputTokens ?? supervisorContext.maxOutputTokens;
  const timeoutMs = supervisorContext.timeoutMs;
  const { provider, secretValue } = supervisorContext;

  let contextSuffix = "";
  if (input.context !== undefined) {
    try {
      contextSuffix = `\n\nContext: ${JSON.stringify(input.context) ?? ""}`;
    } catch {
      contextSuffix = `\n\nContext: ${String(input.context)}`;
    }
  }
  let conversation = `${subAgentSpec.instructions}\n\n${input.task}${contextSuffix}`;

  const trace: AgentTraceItem[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let allProviderUsage = true;
  let text = "";
  let model = supervisorContext.model;
  let status: AgentStatus = "completed";
  let iterations = 0;

  for (let iteration = 1; iteration <= effectiveMax; iteration += 1) {
    if (supervisorContext.context.signal.aborted) {
      status = "error";
      break;
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([supervisorContext.context.signal, timeout]);

    const request = {
      model: supervisorContext.model,
      prompt: conversation,
      maxOutputTokens,
      timeoutMs,
      secretValue,
      signal,
      ...(supervisorContext.systemPrompt !== undefined
        ? { systemPrompt: supervisorContext.systemPrompt }
        : {}),
      ...(supervisorContext.context.idempotencyKey
        ? { idempotencyKey: supervisorContext.context.idempotencyKey }
        : {}),
      ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
    };

    const result = await provider.complete(request);

    promptTokens += result.usage.promptTokens;
    completionTokens += result.usage.completionTokens;
    totalTokens += result.usage.totalTokens;
    if (result.usageSource !== "provider") allProviderUsage = false;
    iterations = iteration;
    model = result.model;
    text = result.text;

    const toolCalls = result.toolCalls ?? [];
    const firstCall = toolCalls[0];
    if (!firstCall || !firstCall.name.trim()) {
      trace.push({ iteration, thought: result.text });
      status = "completed";
      break;
    }

    const dispatchInputs = toolCalls.map((toolCall) => {
      const callName = toolCall.name.trim();
      const callArgs = toSafeArguments(toolCall.arguments);
      return {
        ...(toolCall.id !== undefined ? { id: toolCall.id } : {}),
        name: callName,
        arguments: callArgs,
      };
    });
    const observations = await dispatcher.dispatchMany(
      dispatchInputs,
      supervisorContext.input,
      supervisorContext.context,
    );

    for (let index = 0; index < toolCalls.length; index += 1) {
      const toolCall = toolCalls[index];
      if (!toolCall) continue;
      const callName = toolCall.name.trim();
      const callArgs = toSafeArguments(toolCall.arguments);
      const observation = observations[index];
      if (!observation) continue;
      trace.push({
        iteration,
        ...(index === 0 ? { thought: result.text } : {}),
        toolCall: {
          ...(toolCall.id !== undefined ? { id: toolCall.id } : {}),
          name: callName,
          arguments: callArgs,
        },
        observation: {
          ...(observation.toolCallId !== undefined
            ? { toolCallId: observation.toolCallId }
            : {}),
          output: observation.output,
          durationMs: observation.durationMs,
          isError: observation.isError,
        },
      });
    }

    const observationTexts = observations.map((observation) => {
      try {
        return JSON.stringify(observation.output) ?? "";
      } catch {
        return String(observation.output);
      }
    });
    conversation += `\n\nAssistant: ${result.text}\nObservation[${iteration}]: ${observationTexts.join("\n")}`;

    if (iteration === effectiveMax) {
      status = "iteration_limit_reached";
      break;
    }
  }

  // If loop produced tool-call trace ending at cap, status already set.
  // If loop exited after final text (no tool call), status completed.
  // Edge: effectiveMax reached with tool calls -> iteration_limit_reached.
  const usage: AiUsage = { promptTokens, completionTokens, totalTokens };
  const usageSource: AiUsageSource = allProviderUsage
    ? "provider"
    : "estimated";
  const nestedTrace: AgentNestedTraceItem = {
    subAgentId: subAgentSpec.id,
    role: subAgentSpec.role,
    trace,
    status,
    usage,
  };

  return {
    text,
    model,
    status,
    iterations,
    trace,
    usage,
    usageSource,
    nestedTrace,
  };
}
