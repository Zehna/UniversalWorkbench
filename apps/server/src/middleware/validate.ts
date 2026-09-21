import type { ZodType } from "zod";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function parseRequest<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(400, "BAD_REQUEST", "Invalid request");
  }
  return parsed.data;
}

export function mapDomainError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;

  switch (error.name) {
    case "ProjectNotFoundError":
    case "DocumentNotFoundError":
    case "ArtifactNotFoundError":
      return new HttpError(404, "NOT_FOUND", "Resource not found");
    case "SyncDeviceRejectedError":
      return new HttpError(
        403,
        "SYNC_DEVICE_REJECTED",
        "Sync device is not active",
      );
    case "SyncBatchLimitError":
    case "SyncOperationInvalidError":
      return new HttpError(400, "BAD_REQUEST", "Invalid sync operation");
    case "ToolNotFoundError":
      return new HttpError(404, "TOOL_NOT_FOUND", "Tool version not found");
    case "DirectToolConfigError":
      return new HttpError(
        400,
        "TOOL_CONFIG_INVALID",
        "Direct tool configuration is invalid",
      );
    case "DirectToolCapabilityError":
      return new HttpError(
        403,
        "TOOL_CAPABILITY_DENIED",
        "Direct tool capability is not available",
      );
    case "DirectToolInputRequiredError":
      return new HttpError(
        400,
        "TOOL_INPUT_REQUIRED",
        "Direct tool execution requires workflow-bound inputs",
      );
    case "DirectToolExecutionConflictError":
    case "WorkflowExecutionConflictError":
      return new HttpError(
        409,
        "EXECUTION_CONFLICT",
        "Execution idempotency conflict",
      );
    case "WorkflowPreflightError": {
      const errors = (
        error as Error & {
          errors?: unknown;
        }
      ).errors;
      return new HttpError(400, "WORKFLOW_INVALID", "Workflow is invalid", {
        ...(Array.isArray(errors) ? { errors } : {}),
      });
    }
    case "RevisionConflictError": {
      const currentRevisionId = (
        error as Error & {
          currentRevisionId?: unknown;
        }
      ).currentRevisionId;
      return new HttpError(
        409,
        "REVISION_CONFLICT",
        "Document revision conflict",
        {
          ...(typeof currentRevisionId === "string"
            ? { currentRevisionId }
            : {}),
        },
      );
    }
    default:
      return error;
  }
}
