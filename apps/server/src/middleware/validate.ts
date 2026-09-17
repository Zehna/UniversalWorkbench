import type { ZodType } from "zod";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

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
