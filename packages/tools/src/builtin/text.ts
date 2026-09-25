import { ToolDescriptorSchema } from "@uw/contracts";
import { z } from "zod";
import { ToolRuntimeError } from "../errors.js";
import type { ToolExecutor } from "../runtime.js";
import { createLocalResult, validateInvocation } from "../runtime.js";

const descriptor = ToolDescriptorSchema.parse({
  id: "builtin.text.trim",
  version: "1.0.0",
  name: "Text Trim",
  description: "Remove surrounding whitespace from a text envelope",
  accepts: ["text"],
  produces: ["text"],
  permissions: [],
  capabilities: ["transform"],
  executionMode: "local",
  idempotency: "safe",
  configSchema: { type: "object", additionalProperties: false },
});

export function createTextTrimTool(): ToolExecutor {
  return {
    descriptor,
    async run(input, config, context) {
      const valid = validateInvocation(descriptor, input, context);
      if (!z.strictObject({}).safeParse(config).success) {
        throw new ToolRuntimeError(
          "INVALID_CONFIG",
          "Text Trim does not accept configuration",
        );
      }
      if (typeof valid.payload !== "string") {
        throw new ToolRuntimeError(
          "INVALID_INPUT",
          "Text Trim requires a text payload",
        );
      }
      return createLocalResult(descriptor, valid, context, {
        type: "text",
        mimeType: "text/plain",
        payload: valid.payload.trim(),
      });
    },
  };
}
