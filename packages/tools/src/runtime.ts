import { ContextEnvelopeSchema, ToolDescriptorSchema } from "@uw/contracts";
import type {
  ContextEnvelope,
  ContextType,
  ToolDescriptor,
} from "@uw/contracts";
import { ToolRuntimeError } from "./errors.js";

export interface ToolRunContext {
  executionId: string;
  stepId: string;
  projectId: string;
  traceId: string;
  signal: AbortSignal;
  permissions: ReadonlySet<string>;
}

export interface ToolRunResult {
  outputs: ContextEnvelope[];
  usage: { inputBytes: number; outputBytes: number };
}

export interface ToolExecutor {
  descriptor: ToolDescriptor;
  run(
    input: ContextEnvelope,
    config: unknown,
    context: ToolRunContext,
  ): Promise<ToolRunResult>;
}

export function validateInvocation(
  descriptor: ToolDescriptor,
  input: ContextEnvelope,
  context: ToolRunContext,
): ContextEnvelope {
  if (context.signal.aborted) {
    throw new ToolRuntimeError("ABORTED", "Tool execution was cancelled");
  }

  const parsed = ContextEnvelopeSchema.safeParse(input);
  if (!parsed.success || !descriptor.accepts.includes(input.type)) {
    throw new ToolRuntimeError(
      "INVALID_INPUT",
      "Tool input type or envelope is invalid",
    );
  }

  if (
    !descriptor.permissions.every((permission) =>
      context.permissions.has(permission),
    )
  ) {
    throw new ToolRuntimeError(
      "PERMISSION_DENIED",
      "Tool permissions were not granted",
    );
  }

  return parsed.data;
}

function byteLength(payload: unknown): number {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(payload);
  } catch {
    throw new ToolRuntimeError(
      "INVALID_INPUT",
      "Tool payload cannot be serialized",
    );
  }
  if (encoded === undefined) {
    throw new ToolRuntimeError(
      "INVALID_INPUT",
      "Tool payload cannot be serialized",
    );
  }
  return new TextEncoder().encode(encoded).byteLength;
}

async function derivedId(
  input: ContextEnvelope,
  descriptor: ToolDescriptor,
  context: ToolRunContext,
): Promise<string> {
  const source = [
    input.id,
    context.executionId,
    context.stepId,
    descriptor.id,
    descriptor.version,
  ].join(":");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(source),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function createLocalResult(
  descriptor: ToolDescriptor,
  input: ContextEnvelope,
  context: ToolRunContext,
  output: { type: ContextType; mimeType: string; payload: unknown },
): Promise<ToolRunResult> {
  if (context.signal.aborted) {
    throw new ToolRuntimeError("ABORTED", "Tool execution was cancelled");
  }
  const envelope: ContextEnvelope = {
    id: await derivedId(input, descriptor, context),
    type: output.type,
    schemaVersion: 1,
    mimeType: output.mimeType,
    metadata: { toolId: descriptor.id, toolVersion: descriptor.version },
    payload: output.payload,
    provenance: {
      executionId: context.executionId,
      stepId: context.stepId,
      sourceContextIds: [input.id],
    },
    capabilities: [],
  };
  if (context.signal.aborted) {
    throw new ToolRuntimeError("ABORTED", "Tool execution was cancelled");
  }
  return {
    outputs: [envelope],
    usage: {
      inputBytes: byteLength(input.payload),
      outputBytes: byteLength(output.payload),
    },
  };
}

export async function runTool(
  tool: ToolExecutor,
  input: ContextEnvelope,
  config: unknown,
  context: ToolRunContext,
): Promise<ToolRunResult> {
  const descriptor = ToolDescriptorSchema.safeParse(tool.descriptor);
  if (!descriptor.success) {
    throw new ToolRuntimeError("INVALID_INPUT", "Tool descriptor is invalid");
  }
  const validInput = validateInvocation(descriptor.data, input, context);
  const result = await tool.run(validInput, config, context);
  if (context.signal.aborted) {
    throw new ToolRuntimeError("ABORTED", "Tool execution was cancelled");
  }
  if (
    !Array.isArray(result?.outputs) ||
    !result.outputs.every(
      (value) =>
        ContextEnvelopeSchema.safeParse(value).success &&
        descriptor.data.produces.includes(value.type),
    ) ||
    !result.usage ||
    !Number.isSafeInteger(result.usage.inputBytes) ||
    result.usage.inputBytes < 0 ||
    !Number.isSafeInteger(result.usage.outputBytes) ||
    result.usage.outputBytes < 0
  ) {
    throw new ToolRuntimeError(
      "INVALID_OUTPUT",
      "Tool returned an invalid output envelope",
    );
  }
  return result;
}
