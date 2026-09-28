import { HttpError } from "./validate.js";

export function mapWorkflowHttpError(error: unknown): unknown {
  if (error instanceof HttpError || !(error instanceof Error)) return error;
  const name = error.name;
  const code =
    "code" in error && typeof error.code === "string" ? error.code : "";
  if (name === "WorkflowNotFoundError" || code === "EXECUTION_SCOPE_MISMATCH") {
    return new HttpError(404, "NOT_FOUND", "Resource not found");
  }
  if (
    name === "WorkflowVersionConflictError" ||
    code === "WORKFLOW_VERSION_CONFLICT"
  ) {
    return new HttpError(
      409,
      "WORKFLOW_VERSION_CONFLICT",
      "Workflow version is stale",
    );
  }
  if (code === "INVALID_STATE" || code === "RECEIPT_EXISTS") {
    return new HttpError(
      409,
      "EXECUTION_NOT_CANCELLABLE",
      "Execution is already terminal",
    );
  }
  if (name === "WorkflowValidationError") {
    return code === "MISSING_PERMISSION"
      ? new HttpError(
          403,
          "MISSING_PERMISSION",
          "Workflow requires unavailable permissions",
        )
      : new HttpError(
          400,
          code || "INVALID_WORKFLOW",
          "Workflow validation failed",
        );
  }
  if (
    name === "ExecutionEngineError" &&
    (code === "INVALID_INPUT" || code === "INVALID_BUDGET")
  ) {
    return new HttpError(400, "BAD_REQUEST", "Execution input is invalid");
  }
  return error;
}
