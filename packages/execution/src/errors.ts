import type { StructuredExecutionError } from "./model.js";

export type ExecutionEngineErrorCode =
  | "INVALID_INPUT"
  | "INVALID_BUDGET"
  | "WORKFLOW_VERSION_CONFLICT"
  | "EXECUTION_NOT_FOUND"
  | "INVALID_OUTPUT"
  | "BUDGET_STEPS"
  | "BUDGET_DURATION"
  | "BUDGET_OUTPUT"
  | "TOOL_FAILED"
  | "TIMEOUT"
  | "CANCELLED"
  | "UNCERTAIN_OUTCOME";

export class ExecutionEngineError extends Error {
  constructor(
    public readonly code: ExecutionEngineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExecutionEngineError";
  }
}

const safeCodes = new Set([
  "ABORTED",
  "INVALID_INPUT",
  "INVALID_CONFIG",
  "PERMISSION_DENIED",
  "INVALID_OUTPUT",
  "NETWORK_FAILURE",
  "TIMEOUT",
  "RESPONSE_TOO_LARGE",
]);

export function safeExecutionError(error: unknown): StructuredExecutionError {
  if (error instanceof ExecutionEngineError) {
    return { code: error.code, message: error.message, details: null };
  }
  const rawCode =
    error !== null && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  const code =
    typeof rawCode === "string" && safeCodes.has(rawCode)
      ? rawCode
      : "TOOL_FAILED";
  // Never serialize arbitrary upstream errors, headers, or credential-bearing messages.
  return { code, message: "Workflow tool execution failed", details: null };
}
