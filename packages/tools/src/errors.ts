import type {
  ExecutionErrorCode,
  JsonValue,
} from "@uw/contracts";

export interface ToolExecutionErrorOptions {
  code: ExecutionErrorCode;
  message: string;
  details?: JsonValue;
  retryAfterMs?: number;
  method?: string;
  ambiguous?: boolean;
  retrySafe?: boolean;
}

export class ToolExecutionError extends Error {
  readonly code: ExecutionErrorCode;
  readonly details: JsonValue | undefined;
  readonly retryAfterMs: number | undefined;
  readonly method: string | undefined;
  readonly ambiguous: boolean;
  readonly retrySafe: boolean;

  constructor(options: ToolExecutionErrorOptions) {
    super(options.message);
    this.name = "ToolExecutionError";
    this.code = options.code;
    this.details = options.details;
    this.retryAfterMs = options.retryAfterMs;
    this.method = options.method;
    this.ambiguous = options.ambiguous ?? false;
    this.retrySafe = options.retrySafe ?? false;
  }
}

export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRegistryError";
  }
}

export class DuplicateToolRegistrationError extends ToolRegistryError {
  constructor(
    readonly toolId: string,
    readonly toolVersion: string,
  ) {
    super(`Tool ${toolId}@${toolVersion} is already registered`);
    this.name = "DuplicateToolRegistrationError";
  }
}

export class ToolNotFoundError extends ToolRegistryError {
  constructor(
    readonly toolId: string,
    readonly toolVersion: string,
  ) {
    super(`Tool ${toolId}@${toolVersion} is not registered`);
    this.name = "ToolNotFoundError";
  }
}
