import { ToolDescriptorSchema } from "@uw/contracts";
import { z } from "zod";
import { ToolRuntimeError } from "../errors.js";
import type { ToolExecutor } from "../runtime.js";
import { createLocalResult, validateInvocation } from "../runtime.js";

const descriptor = ToolDescriptorSchema.parse({
  id: "builtin.markdown.to-text",
  version: "1.0.0",
  name: "Markdown to Text",
  description:
    "Transform basic Markdown into plain text without rendering HTML",
  accepts: ["markdown"],
  produces: ["text"],
  permissions: [],
  capabilities: ["transform"],
  executionMode: "local",
  idempotency: "safe",
  configSchema: { type: "object", additionalProperties: false },
});

export function createMarkdownToTextTool(): ToolExecutor {
  return {
    descriptor,
    async run(input, config, context) {
      const valid = validateInvocation(descriptor, input, context);
      if (!z.strictObject({}).safeParse(config).success) {
        throw new ToolRuntimeError(
          "INVALID_CONFIG",
          "Markdown to Text does not accept configuration",
        );
      }
      if (typeof valid.payload !== "string") {
        throw new ToolRuntimeError(
          "INVALID_INPUT",
          "Markdown to Text requires a string payload",
        );
      }

      const payload = valid.payload
        .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
        .replace(/^\s*(?:`{3,}|~{3,})[^\n]*$/gm, "")
        .replace(/!\[([^\]]*)\]\([^\n)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^\n)]*\)/g, "$1")
        .replace(/<\/?[A-Za-z][^>]*>/g, "")
        .replace(/^\s{0,3}#{1,6}\s+/gm, "")
        .replace(/^\s*>\s?/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, "$1$2")
        .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_)/g, "$1$2")
        .replace(/`([^\n`]+)`/g, "$1")
        .trim();

      return createLocalResult(descriptor, valid, context, {
        type: "text",
        mimeType: "text/plain",
        payload,
      });
    },
  };
}
