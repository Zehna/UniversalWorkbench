import { Router } from "express";
import type { OwnerPublic } from "@uw/contracts";
import { IdSchema } from "@uw/contracts";
import type { AuthService } from "@uw/auth";
import type { ArtifactService } from "@uw/artifacts";
import { requireOwner } from "../middleware/auth.js";
import { mapDomainError, parseRequest } from "../middleware/validate.js";

interface ArtifactRouterDependencies {
  authService: AuthService;
  cookieName: string;
  artifactService: ArtifactService;
}

function ownerFromLocals(locals: Record<string, unknown>): OwnerPublic {
  return locals.owner as OwnerPublic;
}

export function createArtifactsRouter(deps: ArtifactRouterDependencies) {
  const router = Router({ mergeParams: true });
  router.use(requireOwner(deps.authService, deps.cookieName));

  router.get("/", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const projectId = parseRequest(IdSchema, req.params.projectId);
      const artifacts = await deps.artifactService.list(owner.id, projectId);
      res.json({ artifacts });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.get("/:artifactId", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const projectId = parseRequest(IdSchema, req.params.projectId);
      const artifactId = parseRequest(IdSchema, req.params.artifactId);
      const artifact = await deps.artifactService.get(
        owner.id,
        projectId,
        artifactId,
      );
      res.json({ artifact });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.get("/:artifactId/content", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const projectId = parseRequest(IdSchema, req.params.projectId);
      const artifactId = parseRequest(IdSchema, req.params.artifactId);
      const artifact = await deps.artifactService.get(
        owner.id,
        projectId,
        artifactId,
      );
      const bytes = await deps.artifactService.getContent(
        owner.id,
        projectId,
        artifactId,
      );

      res.setHeader("Content-Type", artifact.mimeType);
      res.setHeader("Content-Length", String(bytes.byteLength));
      res.setHeader("Content-Disposition", "attachment");
      res.status(200).send(Buffer.from(bytes));
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  return router;
}
