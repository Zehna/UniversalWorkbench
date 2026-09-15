import express from "express";
import type { ErrorRequestHandler } from "express";
import type { ErrorEnvelope } from "@uw/contracts";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { createHealthRouter } from "./routes/health.js";

export interface AppDependencies {
  databaseReady(): Promise<boolean>;
}

export function createApp(deps: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(requestIdMiddleware);
  app.use("/health", createHealthRouter(deps));

  const errorHandler: ErrorRequestHandler = (_error, _req, res, _next) => {
    const requestId =
      typeof res.locals.requestId === "string"
        ? res.locals.requestId
        : undefined;
    const body: ErrorEnvelope = {
      error: {
        code: "INTERNAL_ERROR",
        message: "Unexpected failure",
        ...(requestId ? { requestId } : {}),
      },
    };
    res.status(500).json(body);
  };

  app.use(errorHandler);
  return app;
}
