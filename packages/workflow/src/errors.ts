export type WorkflowValidationCode =
  | "INVALID_WORKFLOW"
  | "DUPLICATE_NODE"
  | "DUPLICATE_EDGE"
  | "DANGLING_EDGE"
  | "SELF_EDGE"
  | "CYCLE"
  | "TOOL_NOT_FOUND"
  | "MISSING_SOURCE"
  | "MISSING_DEPENDENCY"
  | "INVALID_OUTPUT_INDEX"
  | "INCOMPATIBLE_CONTEXT"
  | "MISSING_PERMISSION"
  | "MISSING_IDEMPOTENCY_KEY"
  | "UNSAFE_RETRY";

export class WorkflowValidationError extends Error {
  constructor(
    public readonly code: WorkflowValidationCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowValidationError";
  }
}
