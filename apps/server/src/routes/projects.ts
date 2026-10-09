import { Router } from "express";
import type { OwnerPublic } from "@uw/contracts";
import {
  CreateProjectRequestSchema,
  IdSchema,
  UpdateProjectRequestSchema,
} from "@uw/contracts";
import type { AuthService } from "@uw/auth";
import type { ProjectService } from "@uw/core";
import { requireOwner, type SessionCookieConfig } from "../middleware/auth.js";
import {
  HttpError,
  mapDomainError,
  parseRequest,
} from "../middleware/validate.js";

interface ProjectRouterDependencies {
  authService: AuthService;
  sessionCookie: SessionCookieConfig;
  projectService: ProjectService;
}

function ownerFromLocals(locals: Record<string, unknown>): OwnerPublic {
  return locals.owner as OwnerPublic;
}

function traceIdFromLocals(locals: Record<string, unknown>): string {
  return String(locals.requestId);
}

export function createProjectsRouter(deps: ProjectRouterDependencies) {
  const router = Router();
  router.use(requireOwner(deps.authService, deps.sessionCookie));

  router.get("/", async (_req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const projects = await deps.projectService.list(owner.id);
      res.json({ projects });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const input = parseRequest(CreateProjectRequestSchema, req.body);
      const project = await deps.projectService.create(
        owner.id,
        input,
        traceIdFromLocals(res.locals),
      );
      res.status(201).json({ project });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.get("/:projectId", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const projectId = parseRequest(IdSchema, req.params.projectId);
      const project = await deps.projectService.get(owner.id, projectId);
      res.json({ project });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.patch("/:projectId", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const projectId = parseRequest(IdSchema, req.params.projectId);
      const input = parseRequest(UpdateProjectRequestSchema, req.body);
      const project = await deps.projectService.update(
        owner.id,
        projectId,
        input,
        traceIdFromLocals(res.locals),
      );
      res.json({ project });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.delete("/:projectId", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const projectId = parseRequest(IdSchema, req.params.projectId);
      // Concealment first: another owner's (or missing) project surfaces as
      // 404 before the confirmation check reveals anything.
      await deps.projectService.get(owner.id, projectId);
      // DELETE bodies are unreliable through some proxies, so confirmation
      // is accepted either in the body or as ?confirm=<projectId>.
      const bodyConfirm = (req.body as { confirm?: unknown } | undefined)
        ?.confirm;
      const queryConfirm =
        typeof req.query.confirm === "string" ? req.query.confirm : undefined;
      const confirm =
        typeof bodyConfirm === "string" ? bodyConfirm : queryConfirm;
      if (confirm !== projectId) {
        throw new HttpError(
          400,
          "CONFIRMATION_REQUIRED",
          "Project deletion requires { confirm: <projectId> } or ?confirm=<projectId>",
        );
      }
      await deps.projectService.delete(
        owner.id,
        projectId,
        traceIdFromLocals(res.locals),
      );
      res.json({ deleted: true });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  return router;
}
