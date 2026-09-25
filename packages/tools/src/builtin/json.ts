import { ToolDescriptorSchema } from "@uw/contracts";
import type { ToolExecutor } from "../runtime.js";
import { ToolRuntimeError } from "../errors.js";
import { createLocalResult, validateInvocation } from "../runtime.js";
import { z } from "zod";

const configSchema = z.strictObject({
  path: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z_$][\w$]*(?:\.(?:[A-Za-z_$][\w$]*|0|[1-9]\d*))*$/),
});

const descriptor = ToolDescriptorSchema.parse({
  id: "builtin.json.extract",
  version: "1.0.0",
  name: "JSON Extract",
  description: "Extract a JSON value from a dot-separated property path",
  accepts: ["json"],
  produces: ["json"],
  permissions: [],
  capabilities: ["transform"],
  executionMode: "local",
  idempotency: "safe",
  configSchema: { type: "object", required: ["path"] },
});

export function createJsonExtractTool(): ToolExecutor {
  return {
    descriptor,
    async run(input, config, context) {
      const valid = validateInvocation(descriptor, input, context);
      const parsed = configSchema.safeParse(config);
      if (!parsed.success) {
        throw new ToolRuntimeError(
          "INVALID_CONFIG",
          "JSON extraction path is invalid",
        );
      }

      let current: unknown = valid.payload;
      for (const segment of parsed.data.path.split(".")) {
        if (
          segment === "__proto__" ||
          segment === "prototype" ||
          segment === "constructor" ||
          current === null ||
          typeof current !== "object" ||
          !Object.hasOwn(current, segment)
        ) {
          throw new ToolRuntimeError(
            "INVALID_INPUT",
            "JSON extraction path does not exist",
          );
        }
        current = (current as Record<string, unknown>)[segment];
      }

      return createLocalResult(descriptor, valid, context, {
        type: "json",
        mimeType: "application/json",
        payload: current,
      });
    },
  };
}
