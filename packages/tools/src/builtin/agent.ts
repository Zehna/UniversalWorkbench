import {
  AgentResponsePayloadSchema,
  AiAgentConfigSchema,
  ToolDescriptorSchema,
} from "@uw/contracts";
import type { AgentTraceItem } from "@uw/contracts";
import { AgentToolDispatcher } from "../agent/dispatcher.js";
import type { AgentApprovalResolutionInput } from "../agent/dispatcher.js";
import { ToolRuntimeError } from "../errors.js";
import type { ToolExecutor } from "../runtime.js";
import { createLocalResult, validateInvocation } from "../runtime.js";

// Structural port copy of the provider tool-calling interface — no runtime
// import either way (acyclic deps: tools <- server -> providers). Server
// composition holds a compile-time assignability assertion.
export interface AgentProviderToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface AgentProviderToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentProviderPortRequest {
  model: string;
  prompt: string;
  systemPrompt?: string;
  maxOutputTokens: number;
  timeoutMs: number;
  secretValue: string;
  signal: AbortSignal;
  idempotencyKey?: string;
  tools?: AgentProviderToolDefinition[];
}

export interface AgentProviderPortResult {
  text: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  usageSource: "provider" | "estimated";
  providerRequestId?: string;
  toolCalls?: AgentProviderToolCall[];
}

export interface AgentProviderPort {
  readonly id: string;
  complete(req: AgentProviderPortRequest): Promise<AgentProviderPortResult>;
}

export interface AgentToolDeps {
  providers: Map<string, AgentProviderPort>;
  /**
   * Resolve a `secret://` reference at run time. The engine supplies the
   * owner scope via the tool context; server resolvers must fail closed
   * when it is absent.
   */
  resolveSecret: (ref: string, ownerId?: string) => Promise<string>;
  /** All registered tool executors available for whitelisted dispatch. */
  tools: ToolExecutor[];
}

const descriptor = ToolDescriptorSchema.parse({
  id: "builtin.ai.agent",
  version: "1.0.0",
  name: "AI Agent",
  description: "ReAct agent loop with whitelisted tool calling",
  accepts: ["text", "markdown", "json"],
  produces: ["agent_response"],
  permissions: ["ai"],
  capabilities: ["tool-calling"],
  executionMode: "server",
  idempotency: "keyed",
  configSchema: {
    type: "object",
    required: ["providerId", "model", "prompt", "secretRef"],
  },
});

function inputToText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    const encoded = JSON.stringify(payload);
    return encoded ?? String(payload);
  } catch {
    throw new ToolRuntimeError(
      "INVALID_INPUT",
      "Agent input payload cannot be serialized",
    );
  }
}

function scrubSecret(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret.length > 0 && out.includes(secret)) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  return out;
}

function toSafeArguments(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toApprovalMap(
  value: unknown,
): Record<string, AgentApprovalResolutionInput> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, AgentApprovalResolutionInput> = {};
  let found = false;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      continue;
    const record = entry as Record<string, unknown>;
    if (record["decision"] === "approved") {
      out[key] = { decision: "approved" };
      found = true;
    } else if (record["decision"] === "rejected") {
      const reason =
        typeof record["rejectionReason"] === "string" &&
        record["rejectionReason"].trim().length > 0
          ? (record["rejectionReason"] as string)
          : undefined;
      out[key] =
        reason !== undefined
          ? { decision: "rejected", rejectionReason: reason }
          : { decision: "rejected" };
      found = true;
    }
  }
  return found ? out : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-scrub resolved secret plaintexts from successful payload content
 * (final text, trace thoughts, tool-call arguments, observation outputs)
 * before persistence. Complements the error-path scrub below: provider
 * echoes of the Bearer secret in reasoning text would otherwise persist
 * verbatim in execution outputContexts.
 */
function scrubTraceValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return scrubSecret(value, secrets);
  if (Array.isArray(value)) {
    return value.map((item) => scrubTraceValue(item, secrets));
  }
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = scrubTraceValue(child, secrets);
    }
    return out;
  }
  return value;
}

export function createAgentTool(deps: AgentToolDeps): ToolExecutor {
  return {
    descriptor: ToolDescriptorSchema.parse(descriptor),
    async run(input, config, context) {
      const validInput = validateInvocation(descriptor, input, context);

      const parsed = AiAgentConfigSchema.safeParse(config);
      if (!parsed.success) {
        throw new ToolRuntimeError(
          "INVALID_CONFIG",
          "Agent configuration is invalid",
        );
      }
      const toolConfig = parsed.data;

      const provider = deps.providers.get(toolConfig.providerId);
      if (!provider) {
        if (deps.providers.size === 0) {
          throw new ToolRuntimeError(
            "AI_PROVIDER_NOT_CONFIGURED",
            "AI provider is not configured",
          );
        }
        throw new ToolRuntimeError(
          "INVALID_CONFIG",
          "Agent configuration is invalid",
        );
      }

      let secretValue: string;
      try {
        secretValue = await deps.resolveSecret(
          toolConfig.secretRef,
          context.ownerId,
        );
      } catch (error) {
        if (error instanceof ToolRuntimeError) {
          throw new ToolRuntimeError(
            error.code,
            "Agent secret could not be resolved",
          );
        }
        throw new ToolRuntimeError(
          "INVALID_CONFIG",
          "Agent secret could not be resolved",
        );
      }
      const knownSecrets = secretValue.length > 0 ? [secretValue] : [];

      try {
        if (context.signal.aborted) {
          throw new ToolRuntimeError(
            "ABORTED",
            "Agent execution was cancelled",
          );
        }
        const inputText = inputToText(validInput.payload);
        const dispatcher = new AgentToolDispatcher({
          tools: deps.tools ?? [],
          allowedTools: toolConfig.allowedTools,
        });
        const toolDefs: AgentProviderToolDefinition[] = dispatcher
          .listSpecs()
          .map((spec) => ({
            name: spec.name,
            description: spec.description,
            parameters: spec.parameters,
          }));

        const maxOutputTokens = toolConfig.maxOutputTokens ?? 1024;
        const timeoutMs = 30_000;
        const maxIterations = toolConfig.maxIterations;

        const rawConfig = config as Record<string, unknown>;
        const approvalResolutions = toApprovalMap(
          rawConfig["approvalResolutions"],
        );

        let conversation = `${toolConfig.prompt}\n\n${inputText}`;
        const trace: AgentTraceItem[] = [];
        let promptTokens = 0;
        let completionTokens = 0;
        let totalTokens = 0;
        let allProviderUsage = true;
        let text = "";
        let model = toolConfig.model;
        let status:
          "completed" | "iteration_limit_reached" | "awaiting_approval" =
          "completed";
        let iterations = 0;
        let pendingApprovals:
          | Array<{
              tool: string;
              toolCallId?: string;
              arguments?: Record<string, unknown>;
              reason: string;
            }>
          | undefined;

        for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
          if (context.signal.aborted) {
            throw new ToolRuntimeError(
              "ABORTED",
              "Agent execution was cancelled",
            );
          }
          const timeout = AbortSignal.timeout(timeoutMs);
          const signal = AbortSignal.any([context.signal, timeout]);

          const request: AgentProviderPortRequest = {
            model: toolConfig.model,
            prompt: conversation,
            maxOutputTokens,
            timeoutMs,
            secretValue,
            signal,
          };
          if (toolConfig.systemPrompt !== undefined) {
            request.systemPrompt = toolConfig.systemPrompt;
          }
          if (context.idempotencyKey) {
            request.idempotencyKey = context.idempotencyKey;
          }
          if (toolDefs.length > 0) {
            request.tools = toolDefs;
          }

          let result: AgentProviderPortResult;
          try {
            result = await provider.complete(request);
          } catch (error) {
            if (error instanceof ToolRuntimeError) throw error;
            if (context.signal.aborted || timeout.aborted) {
              const abortedByCaller = context.signal.aborted;
              throw new ToolRuntimeError(
                "ABORTED",
                abortedByCaller
                  ? "Agent execution was cancelled"
                  : "Agent provider request timed out",
              );
            }
            const code = (error as { code?: string }).code;
            if (code === "TIMEOUT")
              throw new ToolRuntimeError(
                "TIMEOUT",
                "Agent provider request timed out",
              );
            if (code === "ABORTED")
              throw new ToolRuntimeError(
                "ABORTED",
                "Agent execution was cancelled",
              );
            throw new ToolRuntimeError(
              "NETWORK_FAILURE",
              "Agent provider request failed",
            );
          }

          if (context.signal.aborted) {
            throw new ToolRuntimeError(
              "ABORTED",
              "Agent execution was cancelled",
            );
          }

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
            validInput,
            context,
            approvalResolutions,
          );

          const awaiting = observations.filter(
            (observation) => observation.requiresApproval === true,
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

          if (awaiting.length > 0) {
            pendingApprovals = awaiting.map((observation) => ({
              tool:
                observation.pendingApproval?.tool ??
                dispatchInputs[observations.indexOf(observation)]?.name ??
                "",
              ...(observation.pendingApproval?.toolCallId !== undefined ||
              observation.toolCallId !== undefined
                ? {
                    toolCallId:
                      observation.pendingApproval?.toolCallId ??
                      observation.toolCallId,
                  }
                : {}),
              arguments: observation.pendingApproval?.arguments ?? {},
              reason:
                observation.pendingApproval?.reason ?? "Tool requires approval",
            }));
            status = "awaiting_approval";
            break;
          }

          const observationTexts = observations.map((observation) => {
            try {
              return JSON.stringify(observation.output) ?? "";
            } catch {
              return String(observation.output);
            }
          });
          conversation += `\n\nAssistant: ${result.text}\nObservation[${iteration}]: ${observationTexts.join("\n")}`;

          if (iteration === maxIterations) {
            status = "iteration_limit_reached";
            break;
          }
        }

        const payloadCandidate = {
          text: scrubSecret(text, knownSecrets),
          model,
          status,
          iterations,
          trace: scrubTraceValue(trace, knownSecrets) as AgentTraceItem[],
          usage: { promptTokens, completionTokens, totalTokens },
          usageSource: allProviderUsage
            ? ("provider" as const)
            : ("estimated" as const),
          ...(pendingApprovals !== undefined
            ? { structured: { pendingApprovals } }
            : {}),
        };
        const payloadParsed =
          AgentResponsePayloadSchema.safeParse(payloadCandidate);
        if (!payloadParsed.success) {
          throw new ToolRuntimeError(
            "INVALID_OUTPUT",
            "Agent provider returned an invalid result",
          );
        }

        return createLocalResult(descriptor, validInput, context, {
          type: "agent_response",
          mimeType: "application/json",
          payload: payloadParsed.data,
        });
      } catch (error) {
        if (error instanceof ToolRuntimeError) {
          const scrubbed = scrubSecret(error.message, knownSecrets);
          if (scrubbed !== error.message) {
            throw new ToolRuntimeError(error.code, scrubbed);
          }
          throw error;
        }
        const message = scrubSecret("Agent execution failed", knownSecrets);
        throw new ToolRuntimeError("NETWORK_FAILURE", message);
      }
    },
  };
}
