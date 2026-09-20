import type {
  ExecutionErrorCode,
  JsonValue,
  SanitizedExecutionError,
} from "@uw/contracts";
import { ToolExecutionError } from "@uw/tools";

export class InvalidExecutionTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`Invalid execution transition: ${from} -> ${to}`);
    this.name = "InvalidExecutionTransitionError";
  }
}

export interface ExecutionFailureOptions {
  code: ExecutionErrorCode;
  message: string;
  details?: JsonValue;
  retryAfterMs?: number;
  method?: string;
  ambiguous?: boolean;
  retrySafe?: boolean;
}

export class ExecutionFailure extends Error {
  readonly code: ExecutionErrorCode;
  readonly details: JsonValue | undefined;
  readonly retryAfterMs: number | undefined;
  readonly method: string | undefined;
  readonly ambiguous: boolean;
  readonly retrySafe: boolean;

  constructor(options: ExecutionFailureOptions) {
    super(options.message);
    this.name = "ExecutionFailure";
    this.code = options.code;
    this.details = options.details;
    this.retryAfterMs = options.retryAfterMs;
    this.method = options.method;
    this.ambiguous = options.ambiguous ?? false;
    this.retrySafe = options.retrySafe ?? false;
  }

  sanitized(): SanitizedExecutionError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function sanitizeExecutionError(error: unknown): SanitizedExecutionError {
  if (error instanceof ExecutionFailure) {
    return error.sanitized();
  }
  if (error instanceof ToolExecutionError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }

  return {
    code: "TOOL_BUG",
    message: "Tool execution failed",
  };
}
