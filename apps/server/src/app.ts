import express from "express";
import type { ErrorRequestHandler, RequestHandler } from "express";
import type { ErrorEnvelope } from "@uw/contracts";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { createHealthRouter } from "./routes/health.js";

export interface AppDependencies {
  databaseReady(): Promise<boolean>;
}

function requestIdFromLocals(
  locals: Record<string, unknown>,
): string | undefined {
  return typeof locals.requestId === "string" ? locals.requestId : undefined;
}

function errorStatus(error: unknown): number {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return 500;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500
    ? status
    : 500;
}

function errorEnvelope(
  code: string,
  message: string,
  requestId?: string,
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      ...(requestId ? { requestId } : {}),
    },
  };
}

export function createApp(deps: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.use(requestIdMiddleware);
  app.use(express.json({ limit: "1mb" }));
  app.use("/health", createHealthRouter(deps));

  const notFoundHandler: RequestHandler = (_req, res) => {
    const body = errorEnvelope(
      "NOT_FOUND",
      "Route not found",
      requestIdFromLocals(res.locals),
    );
    res.status(404).json(body);
  };

  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    const requestId = requestIdFromLocals(res.locals);
    const status = errorStatus(error);

    if (status === 400) {
      const body = errorEnvelope(
        "BAD_REQUEST",
        "Invalid request body",
        requestId,
      );
      res.status(400).json(body);
      return;
    }

    if (status === 413) {
      const body = errorEnvelope(
        "PAYLOAD_TOO_LARGE",
        "Request body too large",
        requestId,
      );
      res.status(413).json(body);
      return;
    }

    if (status >= 400 && status < 500) {
      const body = errorEnvelope("BAD_REQUEST", "Invalid request", requestId);
      res.status(status).json(body);
      return;
    }

    const body = errorEnvelope(
      "INTERNAL_ERROR",
      "Unexpected failure",
      requestId,
    );
    res.status(500).json(body);
  };

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
