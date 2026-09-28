import { Router } from "express";
import type { AuthService } from "@uw/auth";
import type { OwnerPublic } from "@uw/contracts";
import { IdSchema } from "@uw/contracts";
import type { ExecutionRepository } from "@uw/execution";
import { requireOwner, type SessionCookieConfig } from "../middleware/auth.js";
import { HttpError, parseRequest } from "../middleware/validate.js";
import { mapWorkflowHttpError } from "../middleware/workflow-errors.js";

export function createExecutionsRouter(deps: {
  authService: AuthService;
  sessionCookie: SessionCookieConfig;
  repository: ExecutionRepository;
}) {
  const router = Router({ mergeParams: true });
  router.use(requireOwner(deps.authService, deps.sessionCookie));

  async function scoped(
    req: { params: object },
    locals: Record<string, unknown>,
  ) {
    const owner = locals.owner as OwnerPublic;
    const params = req.params as Record<string, unknown>;
    const projectId = parseRequest(IdSchema, params.projectId);
    const executionId = parseRequest(IdSchema, params.executionId);
    const view = await deps.repository.get(owner.id, projectId, executionId);
    if (!view) throw new HttpError(404, "NOT_FOUND", "Execution not found");
    return view;
  }

  router.get("/:executionId", async (req, res, next) => {
    try {
      const view = await scoped(req, res.locals);
      res.json(view);
    } catch (error) {
      next(mapWorkflowHttpError(error));
    }
  });

  router.post("/:executionId/cancel", async (req, res, next) => {
    try {
      // Only the authenticated owner's project can discover an execution.
      if (
        req.body !== undefined &&
        (typeof req.body !== "object" ||
          Object.keys(req.body as object).length > 0)
      ) {
        throw new HttpError(
          400,
          "BAD_REQUEST",
          "Cancellation does not accept a request body",
        );
      }
      const view = await scoped(req, res.locals);
      if (
        view.execution.status !== "queued" &&
        view.execution.status !== "running"
      ) {
        throw new HttpError(
          409,
          "EXECUTION_NOT_CANCELLABLE",
          "Execution is already terminal",
        );
      }
      await deps.repository.cancel(view.execution.id, new Date());
      const owner = res.locals.owner as OwnerPublic;
      const updated = await deps.repository.get(
        owner.id,
        view.execution.projectId,
        view.execution.id,
      );
      res.json(updated);
    } catch (error) {
      next(mapWorkflowHttpError(error));
    }
  });
  return router;
}
