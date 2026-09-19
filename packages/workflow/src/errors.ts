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
