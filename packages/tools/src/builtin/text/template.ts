import type {
  ContextEnvelope,
  ToolDefinition,
} from "@uw/contracts";
import { z } from "zod";
import type { ToolRunner } from "../../contract.js";
import { ToolExecutionError } from "../../errors.js";
import { selectJsonPointer } from "../json/select.js";

const MAX_INLINE_TEXT_BYTES = 1024 * 1024;

const TextTemplateConfigSchema = z
  .object({
    template: z.string(),
    outputType: z.enum(["text", "markdown"]).default("text"),
  })
  .strict();

export interface TextTemplateContextIdGenerator {
  next(): string;
}

export interface CreateTextTemplateToolOptions {
  contextIds: TextTemplateContextIdGenerator;
}

export const TEXT_TEMPLATE_TOOL_DEFINITION: ToolDefinition = {
  id: "builtin.text.template",
  version: "1",
  displayName: "Text Template",
  description: "Render constrained text placeholders without expression evaluation",
  executionMode: "worker",
  accepts: [
    {
      name: "input",
      types: ["text", "markdown", "json"],
      required: false,
    },
    {
      name: "json",
      types: ["json"],
      required: false,
    },
  ],
  produces: [{ name: "output", types: ["text", "markdown"] }],
  configSchema: {
    type: "object",
    required: ["template"],
    additionalProperties: false,
    properties: {
      template: { type: "string" },
      outputType: { type: "string", enum: ["text", "markdown"] },
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

function stringifyInput(input: ContextEnvelope | undefined): string {
  if (!input) throw validation("Template requires the input context");
  if (input.type === "text" || input.type === "markdown") {
    if (typeof input.payload !== "string") {
      throw validation("Template text input must contain a string payload");
    }
    return input.payload;
  }
  if (input.type === "json") return JSON.stringify(input.payload);
  throw validation("Template input type is not supported");
}

function stringifyJsonValue(value: ContextEnvelope["payload"]): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function createTextTemplateTool(
  options: CreateTextTemplateToolOptions,
): ToolRunner {
  return {
    async run(context) {
      const parsed = TextTemplateConfigSchema.safeParse(context.config);
      if (!parsed.success) throw validation("Text template configuration is invalid");

      const template = parsed.data.template;
      let rendered = "";
      let cursor = 0;
      const placeholder = /{{([^{}]+)}}/g;

      for (const match of template.matchAll(placeholder)) {
        const index = match.index ?? 0;
        rendered += template.slice(cursor, index);
        const expression = match[1]!.trim();

        if (expression === "input") {
          rendered += stringifyInput(context.inputs.input);
        } else if (expression.startsWith("json:")) {
          const json = context.inputs.json;
          if (!json || json.type !== "json") {
            throw validation("Template JSON placeholder requires a json input");
          }
          const pointer = expression.slice("json:".length);
          rendered += stringifyJsonValue(selectJsonPointer(json.payload, pointer));
        } else {
          throw validation("Template contains an unsupported placeholder");
        }

        cursor = index + match[0].length;
      }

      rendered += template.slice(cursor);
      if (rendered.includes("{{") || rendered.includes("}}")) {
        throw validation("Template contains an invalid placeholder");
      }

      const bytes = new TextEncoder().encode(rendered);
      if (bytes.byteLength > MAX_INLINE_TEXT_BYTES) {
        throw new ToolExecutionError({
          code: "OUTPUT_TOO_LARGE",
          message: "Rendered text exceeds the inline context limit",
          retrySafe: false,
        });
      }

      const parentContextIds = Object.values(context.inputs).map(
        (input) => input.id,
      );
      const artifactIds = [
        ...new Set(
          Object.values(context.inputs).flatMap(
            (input) => input.provenance.artifactIds,
          ),
        ),
      ];
      const outputType = parsed.data.outputType;
      const output: ContextEnvelope = {
        id: options.contextIds.next(),
        type: outputType,
        schemaVersion: 1,
        mimeType: outputType === "markdown" ? "text/markdown" : "text/plain",
        metadata: {},
        payload: rendered,
        provenance: {
          projectId: context.projectId,
          artifactIds,
          executionId: context.executionId,
          stepExecutionId: context.stepExecutionId,
          parentContextIds,
        },
        capabilities: [],
      };

      return {
        outputs: { output },
        usage: { outputBytes: bytes.byteLength, httpRequests: 0 },
      };
    },
  };
}
