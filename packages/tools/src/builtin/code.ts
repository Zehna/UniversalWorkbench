import {
  CodeInterpreterConfigSchema,
  ToolDescriptorSchema,
  type ToolDescriptor,
} from "@uw/contracts";
import { ToolRuntimeError } from "../errors.js";
import { createLocalResult, validateInvocation, type ToolExecutor } from "../runtime.js";
import { createCodeSandbox, type CodeSandbox } from "../code/sandbox.js";

export const CODE_INTERPRETER_TOOL_NAME = "builtin.code.interpreter@1.0.0";

const descriptor: ToolDescriptor = {
  id: "builtin.code.interpreter",
  version: "1.0.0",
  name: "Code Interpreter",
  description:
    "Executes sandboxed JavaScript computation scripts safely with timeout and output capture.",
  accepts: ["text", "json", "code_result"],
  produces: ["code_result", "json", "text"],
  permissions: [],
  capabilities: ["compute", "json", "text"],
  executionMode: "local",
  idempotency: "safe",
  configSchema: {
    type: "object",
    properties: {
      code: { type: "string" },
      language: { type: "string", enum: ["javascript", "typescript"] },
      timeoutMs: { type: "number" },
    },
    required: ["code"],
  },
  requiresApproval: false,
};

export function createCodeInterpreterTool(options?: {
  sandbox?: CodeSandbox;
}): ToolExecutor {
  const sandbox = options?.sandbox ?? createCodeSandbox();
  const validDescriptor = ToolDescriptorSchema.parse(descriptor);

  return {
    descriptor: validDescriptor,
    async run(input, config, context) {
      const valid = validateInvocation(validDescriptor, input, context);
      const parsed = CodeInterpreterConfigSchema.safeParse(config);
      if (!parsed.success) {
        throw new ToolRuntimeError(
          "INVALID_CONFIG",
          "Code interpreter configuration is invalid",
        );
      }

      const outcome = await sandbox.run({
        code: parsed.data.code,
        timeoutMs: parsed.data.timeoutMs,
        input: input.payload,
      });

      if (!outcome.success) {
        throw new ToolRuntimeError(
          "INVALID_OUTPUT",
          outcome.stderr || outcome.error || "Code execution failed",
          outcome,
        );
      }

      return createLocalResult(validDescriptor, valid, context, {
        type: "code_result",
        mimeType: "application/json",
        payload: outcome,
      });
    },
  };
}
