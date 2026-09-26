import express from "express";
import type { ErrorRequestHandler, RequestHandler } from "express";
import type { AuthService } from "@uw/auth";
import type { ArtifactService } from "@uw/artifacts";
import type { ErrorEnvelope } from "@uw/contracts";
import type { ProjectService } from "@uw/core";
import type { DocumentService } from "@uw/documents";
import type { SyncService } from "@uw/sync";
import type { WorkflowService } from "@uw/workflow";
import type { ToolRegistry } from "@uw/tools";
import type { ExecutionRepository } from "@uw/execution";
import type { SessionCookieConfig } from "./middleware/auth.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { createAuthRouter } from "./routes/auth.js";
import { createArtifactsRouter } from "./routes/artifacts.js";
import { createDocumentsRouter } from "./routes/documents.js";
import { createHealthRouter } from "./routes/health.js";
import { createProjectsRouter } from "./routes/projects.js";
import { createSetupRouter } from "./routes/setup.js";
import { createSyncRouter } from "./routes/sync.js";
import { createToolsRouter } from "./routes/tools.js";
import { createWorkflowsRouter } from "./routes/workflows.js";
import { createExecutionsRouter } from "./routes/executions.js";

export interface AppDependencies {
  databaseReady(): Promise<boolean>;
  authService?: AuthService;
  sessionCookie?: SessionCookieConfig;
  projectService?: ProjectService;
  documentService?: DocumentService;
  artifactService?: ArtifactService;
  syncService?: SyncService;
  workflowService?: WorkflowService;
  toolRegistry?: ToolRegistry;
  executionRepository?: ExecutionRepository;
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

function errorCode(error: unknown, fallback: string): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return fallback;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : fallback;
}

function hasExplicitErrorCode(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0;
}

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.length === 0) return fallback;
  return error.message;
}

function errorDetails(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== "object" || error === null || !("details" in error)) {
    return undefined;
  }
  const details = (error as { details?: unknown }).details;
  return typeof details === "object" && details !== null
    ? (details as Record<string, unknown>)
    : undefined;
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

function hasAuthDependencies(deps: AppDependencies): deps is AppDependencies & {
  authService: AuthService;
  sessionCookie: SessionCookieConfig;
} {
  return Boolean(deps.authService && deps.sessionCookie);
}

function hasDataDependencies(deps: AppDependencies): deps is AppDependencies & {
  authService: AuthService;
  sessionCookie: SessionCookieConfig;
  projectService: ProjectService;
  documentService: DocumentService;
  artifactService: ArtifactService;
} {
  return Boolean(
    hasAuthDependencies(deps) &&
    deps.projectService &&
    deps.documentService &&
    deps.artifactService,
  );
}

export function createApp(deps: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.use(requestIdMiddleware);
  app.use(express.json({ limit: "1mb" }));
  app.use("/health", createHealthRouter(deps));

  if (hasAuthDependencies(deps)) {
    app.use("/setup", createSetupRouter(deps.authService, deps.sessionCookie));
    app.use("/auth", createAuthRouter(deps.authService, deps.sessionCookie));
  }

  if (hasAuthDependencies(deps) && deps.syncService) {
    app.use(
      "/sync",
      createSyncRouter({
        authService: deps.authService,
        sessionCookie: deps.sessionCookie,
        syncService: deps.syncService,
      }),
    );
  }

  if (hasDataDependencies(deps)) {
    const common = {
      authService: deps.authService,
      sessionCookie: deps.sessionCookie,
    };
    app.use(
      "/projects/:projectId/documents",
      createDocumentsRouter({
        ...common,
        documentService: deps.documentService,
      }),
    );
    app.use(
      "/projects/:projectId/artifacts",
      createArtifactsRouter({
        ...common,
        artifactService: deps.artifactService,
      }),
    );
    app.use(
      "/projects",
      createProjectsRouter({ ...common, projectService: deps.projectService }),
    );
  }

  if (hasAuthDependencies(deps) && deps.toolRegistry) {
    app.use(
      "/api/tools",
      createToolsRouter({
        authService: deps.authService,
        sessionCookie: deps.sessionCookie,
        registry: deps.toolRegistry,
      }),
    );
  }

  if (hasAuthDependencies(deps) && deps.workflowService) {
    app.use(
      "/api/projects/:projectId/workflows",
      createWorkflowsRouter({
        authService: deps.authService,
        sessionCookie: deps.sessionCookie,
        service: deps.workflowService,
      }),
    );
  }

  if (hasAuthDependencies(deps) && deps.executionRepository) {
    app.use(
      "/api/projects/:projectId/executions",
      createExecutionsRouter({
        authService: deps.authService,
        sessionCookie: deps.sessionCookie,
        repository: deps.executionRepository,
      }),
    );
  }

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
      const fallbackMessage =
        status === 400 ? "Invalid request body" : "Invalid request";
      const body = errorEnvelope(
        errorCode(error, "BAD_REQUEST"),
        hasExplicitErrorCode(error)
          ? errorMessage(error, fallbackMessage)
          : fallbackMessage,
        requestId,
      ) as ErrorEnvelope & { error: Record<string, unknown> };
      const details = errorDetails(error);
      if (details) Object.assign(body.error, details);
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
