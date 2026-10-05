import {
  AiResponsePayloadSchema,
  AiToolConfigSchema,
  ToolDescriptorSchema,
} from "@uw/contracts";
import { ToolRuntimeError } from "../errors.js";
import type { ToolExecutor } from "../runtime.js";
import { createLocalResult, validateInvocation } from "../runtime.js";

// Structural port copy of the provider interface — no runtime import either way
// (acyclic deps: tools <- server -> providers). Server composition holds a
// compile-time assignability assertion.
export interface AiProviderPortRequest {
  model: string;
  prompt: string;
  systemPrompt?: string;
  responseFormat: { kind: "text" } | { kind: "json"; jsonSchema: Record<string, unknown> };
  maxOutputTokens: number;
  timeoutMs: number;
  secretValue: string;
  signal: AbortSignal;
  idempotencyKey?: string;
}

export interface AiProviderPortResult {
  text: string;
  model: string;
  structured?: unknown;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  usageSource: "provider" | "estimated";
  providerRequestId?: string;
}

export interface AiProviderPort {
  readonly id: string;
  complete(req: AiProviderPortRequest): Promise<AiProviderPortResult>;
}

export interface AiToolDeps {
  providers: Map<string, AiProviderPort>;
  /**
   * Resolve a `secret://` reference at run time. The engine supplies the
   * owner scope via the tool context; server resolvers must fail closed
   * when it is absent.
   */
  resolveSecret: (ref: string, ownerId?: string) => Promise<string>;
}

const descriptor = ToolDescriptorSchema.parse({
  id: "builtin.ai.complete",
  version: "1.0.0",
  name: "AI Complete",
  description: "Provider-backed chat completion with structured outputs",
  accepts: ["text", "markdown", "json"],
  produces: ["ai_response"],
  permissions: ["ai"],
  capabilities: ["structured-output"],
  executionMode: "server",
  idempotency: "keyed",
  configSchema: { type: "object", required: ["providerId", "model", "prompt", "secretRef"] },
});

function inputToText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    const encoded = JSON.stringify(payload);
    return encoded ?? String(payload);
  } catch {
    throw new ToolRuntimeError("INVALID_INPUT", "AI input payload cannot be serialized");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}

function validateAgainstSchema(schema: unknown, value: unknown): boolean {
  if (typeof schema === "boolean") return schema;
  if (!isPlainObject(schema)) return true;

  const record = schema as Record<string, unknown>;

  if ("const" in record) {
    try {
      if (JSON.stringify(record.const) !== JSON.stringify(value)) return false;
    } catch {
      return false;
    }
  }
  if (Array.isArray(record.enum)) {
    const match = record.enum.some((option) => {
      try {
        return JSON.stringify(option) === JSON.stringify(value);
      } catch {
        return false;
      }
    });
    if (!match) return false;
  }

  const typeField = record.type;
  if (typeof typeField === "string") {
    if (!checkType(typeField, value)) return false;
  } else if (Array.isArray(typeField)) {
    const ok = typeField.some(
      (t) => typeof t === "string" && checkType(t, value),
    );
    if (!ok) return false;
  }

  if (typeof value === "string") {
    if (typeof record.minLength === "number" && value.length < record.minLength) return false;
    if (typeof record.maxLength === "number" && value.length > record.maxLength) return false;
    if (typeof record.pattern === "string") {
      try {
        if (!new RegExp(record.pattern).test(value)) return false;
      } catch {
        return false;
      }
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof record.minimum === "number" && value < record.minimum) return false;
    if (typeof record.maximum === "number" && value > record.maximum) return false;
  }

  if (isPlainObject(value)) {
    if (Array.isArray(record.required)) {
      for (const key of record.required) {
        if (typeof key !== "string" || !Object.hasOwn(value, key)) return false;
      }
    }
    if (isPlainObject(record.properties)) {
      for (const [key, sub] of Object.entries(record.properties)) {
        if (Object.hasOwn(value, key)) {
          if (!validateAgainstSchema(sub, (value as Record<string, unknown>)[key])) return false;
        }
      }
    }
    if (record.additionalProperties === false && isPlainObject(record.properties)) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(record.properties, key)) return false;
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof record.minItems === "number" && value.length < record.minItems) return false;
    if (typeof record.maxItems === "number" && value.length > record.maxItems) return false;
    if (record.items !== undefined) {
      if (Array.isArray(record.items)) {
        for (let i = 0; i < record.items.length; i += 1) {
          if (i < value.length && !validateAgainstSchema(record.items[i], value[i])) return false;
        }
      } else if (!value.every((item) => validateAgainstSchema(record.items, item))) {
        return false;
      }
    }
  }

  return true;
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

export function createAiTool(deps: AiToolDeps): ToolExecutor {
  return {
    descriptor: ToolDescriptorSchema.parse(descriptor),
    async run(input, config, context) {
      const validInput = validateInvocation(descriptor, input, context);

      const parsed = AiToolConfigSchema.safeParse(config);
      if (!parsed.success) {
        throw new ToolRuntimeError("INVALID_CONFIG", "AI configuration is invalid");
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
        throw new ToolRuntimeError("INVALID_CONFIG", "AI configuration is invalid");
      }

      let secretValue: string;
      try {
        secretValue = await deps.resolveSecret(
          toolConfig.secretRef,
          context.ownerId,
        );
      } catch (error) {
        if (error instanceof ToolRuntimeError) {
          // Preserve typed codes (e.g. LOCAL_SECRET_NOT_AVAILABLE_ON_SERVER)
          // but never echo resolver detail that could carry secret bytes.
          throw new ToolRuntimeError(error.code, "AI secret could not be resolved");
        }
        throw new ToolRuntimeError("INVALID_CONFIG", "AI secret could not be resolved");
      }
      const knownSecrets = secretValue.length > 0 ? [secretValue] : [];

      try {
        if (context.signal.aborted) {
          throw new ToolRuntimeError("ABORTED", "AI execution was cancelled");
        }
        const inputText = inputToText(validInput.payload);
        const prompt = `${toolConfig.prompt}\n\n${inputText}`;
        const responseFormat = toolConfig.responseFormat ?? { kind: "text" as const };
        const maxOutputTokens = toolConfig.maxOutputTokens ?? 1024;
        const timeoutMs = toolConfig.timeoutMs ?? 30_000;

        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = AbortSignal.any([context.signal, timeout]);

        const request: AiProviderPortRequest = {
          model: toolConfig.model,
          prompt,
          responseFormat: responseFormat as AiProviderPortRequest["responseFormat"],
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

        let result: AiProviderPortResult;
        try {
          result = await provider.complete(request);
        } catch (error) {
          if (error instanceof ToolRuntimeError) throw error;
          const name = (error as { name?: unknown }).name;
          if (name === "TimeoutError" || (error as Error)?.name === "TimeoutError") {
            throw new ToolRuntimeError("TIMEOUT", "AI provider request timed out");
          }
          if (context.signal.aborted || timeout.aborted) {
            const abortedByCaller = context.signal.aborted;
            throw new ToolRuntimeError(
              "ABORTED",
              abortedByCaller ? "AI execution was cancelled" : "AI provider request timed out",
            );
          }
          const code = (error as { code?: string }).code;
          if (code === "TIMEOUT") throw new ToolRuntimeError("TIMEOUT", "AI provider request timed out");
          if (code === "ABORTED") throw new ToolRuntimeError("ABORTED", "AI execution was cancelled");
          throw new ToolRuntimeError("NETWORK_FAILURE", "AI provider request failed");
        }

        if (context.signal.aborted) {
          throw new ToolRuntimeError("ABORTED", "AI execution was cancelled");
        }

        let structured = result.structured;
        if (responseFormat.kind === "json") {
          let candidate: unknown = structured;
          if (candidate === undefined) {
            try {
              candidate = JSON.parse(result.text) as unknown;
            } catch {
              throw new ToolRuntimeError(
                "AI_SCHEMA_MISMATCH",
                "AI output did not match the required JSON schema",
              );
            }
          }
          if (!validateAgainstSchema(responseFormat.jsonSchema, candidate)) {
            throw new ToolRuntimeError(
              "AI_SCHEMA_MISMATCH",
              "AI output did not match the required JSON schema",
            );
          }
          structured = candidate;
        }

        const payloadCandidate = {
          text: result.text,
          model: result.model,
          ...(structured === undefined ? {} : { structured }),
          usage: result.usage,
          usageSource: result.usageSource,
          ...(result.providerRequestId === undefined
            ? {}
            : { providerRequestId: result.providerRequestId }),
        };
        const payloadParsed = AiResponsePayloadSchema.safeParse(payloadCandidate);
        if (!payloadParsed.success) {
          throw new ToolRuntimeError("INVALID_OUTPUT", "AI provider returned an invalid result");
        }

        return createLocalResult(descriptor, validInput, context, {
          type: "ai_response",
          mimeType: "application/json",
          payload: payloadParsed.data,
        });
      } catch (error) {
        if (error instanceof ToolRuntimeError) {
          // Belt-and-braces: scrub any secret bytes that slipped into
          // message/stack/extra fields without changing the typed code.
          const scrubbed = scrubSecret(error.message, knownSecrets);
          if (scrubbed !== error.message) {
            throw new ToolRuntimeError(error.code, scrubbed);
          }
          throw error;
        }
        const message = scrubSecret("AI execution failed", knownSecrets);
        throw new ToolRuntimeError("NETWORK_FAILURE", message);
      }
    },
  };
}
