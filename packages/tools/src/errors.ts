export class ToolRegistryError extends Error {
  constructor(
    public readonly code:
      "DUPLICATE_TOOL" | "TOOL_NOT_FOUND" | "INVALID_DESCRIPTOR",
    message: string,
  ) {
    super(message);
    this.name = "ToolRegistryError";
  }
}

export type ToolRuntimeErrorCode =
  | "INVALID_INPUT"
  | "INVALID_CONFIG"
  | "PERMISSION_DENIED"
  | "ABORTED"
  | "INVALID_OUTPUT"
  | "NETWORK_FAILURE"
  | "TIMEOUT"
  | "RESPONSE_TOO_LARGE"
  | "AI_SCHEMA_MISMATCH"
  | "AI_PROVIDER_NOT_CONFIGURED"
  | "LOCAL_SECRET_NOT_AVAILABLE_ON_SERVER";

export class ToolRuntimeError extends Error {
  constructor(
    public readonly code: ToolRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolRuntimeError";
  }
}
