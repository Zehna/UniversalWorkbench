export type WorkflowValidationErrorCode =
  | "DUPLICATE_NODE"
  | "UNKNOWN_TOOL"
  | "UNKNOWN_PORT"
  | "TYPE_MISMATCH"
  | "MISSING_INPUT"
  | "WORKFLOW_CYCLE"
  | "NO_TERMINAL"
  | "CAPABILITY_DENIED"
  | "BUDGET_EXCEEDED";

export interface WorkflowValidationError {
  code: WorkflowValidationErrorCode;
  nodeId?: string;
  message: string;
}

export class WorkflowBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowBindingError";
  }
}

export class WorkflowPreflightError extends Error {
  constructor(readonly errors: WorkflowValidationError[]) {
    super(
      errors.length === 0
        ? "Workflow preflight failed"
        : errors.map((error) => error.message).join("; "),
    );
    this.name = "WorkflowPreflightError";
  }
}

export class WorkflowExecutionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowExecutionConflictError";
  }
}
