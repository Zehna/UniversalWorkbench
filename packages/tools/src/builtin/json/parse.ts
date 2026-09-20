import {
  JsonValueSchema,
  type ContextEnvelope,
  type ToolDefinition,
} from "@uw/contracts";
import type { ToolRunner } from "../../contract.js";
import { ToolExecutionError } from "../../errors.js";

const MAX_INLINE_JSON_BYTES = 1024 * 1024;

export interface JsonArtifactReader {
  getContent(
    ownerId: string,
    projectId: string,
    artifactId: string,
  ): Promise<Uint8Array>;
}

export interface JsonContextIdGenerator {
  next(): string;
}

export interface CreateJsonParseToolOptions {
  artifacts: JsonArtifactReader;
  contextIds: JsonContextIdGenerator;
}

export const JSON_PARSE_TOOL_DEFINITION: ToolDefinition = {
  id: "builtin.json.parse",
  version: "1",
  displayName: "JSON Parse",
  description: "Parse UTF-8 JSON from text or an HTTP response artifact",
  executionMode: "worker",
  accepts: [
    {
      name: "input",
      types: ["text", "api-response"],
      required: true,
    },
  ],
  produces: [{ name: "output", types: ["json"] }],
  configSchema: {
    type: "object",
    additionalProperties: false,
  },
  requiredCapabilities: ["project.artifacts.read"],
  defaults: { timeoutMs: 5_000, maxAttempts: 1 },
};

function validation(message: string): ToolExecutionError {
  return new ToolExecutionError({
    code: "VALIDATION",
    message,
    retrySafe: false,
  });
}

function apiResponseArtifactId(input: ContextEnvelope): string {
  if (
    input.type !== "api-response" ||
    typeof input.payload !== "object" ||
    input.payload === null ||
    Array.isArray(input.payload)
  ) {
    throw validation("JSON parse input must be text or api-response");
  }

  const artifactId = input.payload.bodyArtifactId;
  if (typeof artifactId !== "string" || artifactId.length === 0) {
    throw validation("API response is missing bodyArtifactId");
  }
  return artifactId;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw validation("JSON input is not valid UTF-8");
  }
}

function ensureInlineLimit(text: string): void {
  if (new TextEncoder().encode(text).byteLength > MAX_INLINE_JSON_BYTES) {
    throw new ToolExecutionError({
      code: "OUTPUT_TOO_LARGE",
      message: "Parsed JSON exceeds the inline context limit",
      retrySafe: false,
    });
  }
}

function parseJson(text: string): ContextEnvelope["payload"] {
  ensureInlineLimit(text);
  try {
    return JsonValueSchema.parse(JSON.parse(text));
  } catch {
    throw validation("JSON input is invalid");
  }
}

export function createJsonParseTool(
  options: CreateJsonParseToolOptions,
): ToolRunner {
  return {
    async run(context) {
      const input = context.inputs.input;
      if (!input) throw validation("JSON parse requires an input context");

      let text: string;
      if (input.type === "text") {
        if (typeof input.payload !== "string") {
          throw validation("Text JSON input must contain a string payload");
        }
        text = input.payload;
      } else if (input.type === "api-response") {
        const artifactId = apiResponseArtifactId(input);
        const bytes = await options.artifacts.getContent(
          context.ownerId,
          context.projectId,
          artifactId,
        );
        text = decodeUtf8(bytes);
      } else {
        throw validation("JSON parse input must be text or api-response");
      }

      const payload = parseJson(text);
      const output: ContextEnvelope = {
        id: options.contextIds.next(),
        type: "json",
        schemaVersion: 1,
        mimeType: "application/json",
        metadata: {},
        payload,
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
