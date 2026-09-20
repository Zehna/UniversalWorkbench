import type {
  ContextEnvelope,
  JsonValue,
  ToolDefinition,
} from "@uw/contracts";
import { z } from "zod";
import type { ToolRunner } from "../../contract.js";
import { ToolExecutionError } from "../../errors.js";

const JsonSelectConfigSchema = z
  .object({
    pointer: z.string(),
  })
  .strict();

export interface JsonSelectContextIdGenerator {
  next(): string;
}

export interface CreateJsonSelectToolOptions {
  contextIds: JsonSelectContextIdGenerator;
}

export const JSON_SELECT_TOOL_DEFINITION: ToolDefinition = {
  id: "builtin.json.select",
  version: "1",
  displayName: "JSON Select",
  description: "Select a value using an RFC 6901 JSON Pointer",
  executionMode: "worker",
  accepts: [{ name: "input", types: ["json"], required: true }],
  produces: [{ name: "output", types: ["json"] }],
  configSchema: {
    type: "object",
    required: ["pointer"],
    additionalProperties: false,
    properties: {
      pointer: { type: "string" },
    },
  },
  requiredCapabilities: [],
  defaults: { timeoutMs: 5_000, maxAttempts: 1 },
};

function validation(message: string): ToolExecutionError {
  return new ToolExecutionError({
    code: "VALIDATION",
    message,
    retrySafe: false,
  });
}

function decodePointerToken(token: string): string {
  if (/~(?:[^01]|$)/.test(token)) {
    throw validation("JSON Pointer contains an invalid escape");
  }
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function selectJsonPointer(value: JsonValue, pointer: string): JsonValue {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) {
    throw validation("JSON Pointer must be empty or begin with '/'");
  }

  let current: JsonValue = value;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = decodePointerToken(rawToken);

    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) {
        throw validation("JSON Pointer array token is invalid");
      }
      const index = Number(token);
      if (index >= current.length) {
        throw validation("JSON Pointer does not exist");
      }
      current = current[index]!;
      continue;
    }

    if (typeof current === "object" && current !== null) {
      if (!Object.prototype.hasOwnProperty.call(current, token)) {
        throw validation("JSON Pointer does not exist");
      }
      current = current[token]!;
      continue;
    }

    throw validation("JSON Pointer does not exist");
  }

  return current;
}

export function createJsonSelectTool(
  options: CreateJsonSelectToolOptions,
): ToolRunner {
  return {
    async run(context) {
      const parsed = JsonSelectConfigSchema.safeParse(context.config);
      if (!parsed.success) throw validation("JSON select configuration is invalid");

      const input = context.inputs.input;
      if (!input || input.type !== "json") {
        throw validation("JSON select requires a json input");
      }

      const payload = selectJsonPointer(input.payload, parsed.data.pointer);
      const output: ContextEnvelope = {
        id: options.contextIds.next(),
        type: "json",
        schemaVersion: 1,
        mimeType: "application/json",
        metadata: {},
        payload: structuredClone(payload),
        provenance: {
          projectId: context.projectId,
          artifactIds: [...input.provenance.artifactIds],
          executionId: context.executionId,
          stepExecutionId: context.stepExecutionId,
          parentContextIds: [input.id],
        },
        capabilities: [],
      };

      return {
        outputs: { output },
        usage: {
          outputBytes: new TextEncoder().encode(JSON.stringify(payload)).byteLength,
          httpRequests: 0,
        },
      };
    },
  };
}
