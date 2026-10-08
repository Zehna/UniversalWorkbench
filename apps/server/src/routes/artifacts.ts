import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { OwnerPublic } from "@uw/contracts";
import { IdSchema } from "@uw/contracts";
import type { AuthService } from "@uw/auth";
import type { ArtifactService } from "@uw/artifacts";
import {
  MAX_INLINE_JSON_BYTES,
  sanitizeFilename,
  validateArtifactUpload,
} from "@uw/artifacts";
import type { ExecutionRepository } from "@uw/execution";
import { requireOwner, type SessionCookieConfig } from "../middleware/auth.js";
import {
  HttpError,
  mapDomainError,
  parseRequest,
} from "../middleware/validate.js";

interface ArtifactRouterDependencies {
  authService: AuthService;
  sessionCookie: SessionCookieConfig;
  artifactService: ArtifactService;
  executionRepository?: ExecutionRepository;
}

function ownerFromLocals(locals: Record<string, unknown>): OwnerPublic {
  return locals.owner as OwnerPublic;
}

function projectIdFromParams(params: object): string {
  return parseRequest(IdSchema, (params as Record<string, unknown>).projectId);
}

function toUploadHttpError(error: unknown): unknown {
  if (error instanceof Error) {
    if (error.name === "ArtifactTooLargeError") {
      return new HttpError(413, "OUTPUT_TOO_LARGE", error.message);
    }
    if (error.name === "InvalidArtifactContentError") {
      return new HttpError(400, "INVALID_CONTENT", error.message);
    }
  }
  return mapDomainError(error);
}

function downloadFilename(
  metadata: Record<string, unknown>,
  artifactId: string,
): string {
  const raw =
    typeof metadata.filename === "string" && metadata.filename.length > 0
      ? metadata.filename
      : artifactId;
  return sanitizeFilename(raw);
}

export function createArtifactsRouter(deps: ArtifactRouterDependencies) {
  const router = Router({ mergeParams: true });
  router.use(requireOwner(deps.authService, deps.sessionCookie));

  const FromExecutionSchema = z.strictObject({
    executionId: IdSchema,
    outputContextId: IdSchema,
  });

  router.post("/from-execution", async (req, res, next) => {
    try {
      if (!deps.executionRepository) {
        throw new HttpError(
          503,
          "UNAVAILABLE",
          "Execution output saving is unavailable",
        );
      }
      const owner = ownerFromLocals(res.locals);
      const projectId = projectIdFromParams(req.params);
      const { executionId, outputContextId } = parseRequest(
        FromExecutionSchema,
        req.body,
      );
      // The artifact content comes exclusively from a completed, owner-scoped
      // execution record, never from client-submitted output bytes or metadata.
      const view = await deps.executionRepository.get(
        owner.id,
        projectId,
        executionId,
      );
      if (!view) throw new HttpError(404, "NOT_FOUND", "Execution not found");
      if (view.execution.status !== "completed") {
        throw new HttpError(
          409,
          "EXECUTION_NOT_COMPLETED",
          "Only completed outputs can be saved",
        );
      }
      const step = view.steps.find(
        (item) =>
          item.status === "completed" &&
          item.outputContexts.some((output) => output.id === outputContextId),
      );
      const output = step?.outputContexts.find(
        (item) => item.id === outputContextId,
      );
      if (!step || !output) {
        throw new HttpError(404, "NOT_FOUND", "Output context not found");
      }
      const serialized = JSON.stringify(output.payload);
      if (serialized === undefined) {
        throw new HttpError(
          400,
          "INVALID_OUTPUT",
          "Output cannot be serialized",
        );
      }
      const bytes = new TextEncoder().encode(serialized);
      if (bytes.byteLength > MAX_INLINE_JSON_BYTES) {
        throw new HttpError(413, "OUTPUT_TOO_LARGE", "Output exceeds 512 KB");
      }
      try {
        validateArtifactUpload(bytes, "application/json", {
          maxBytes: MAX_INLINE_JSON_BYTES,
        });
      } catch (error) {
        throw toUploadHttpError(error);
      }
      const requestId = res.locals.requestId;
      const traceId =
        typeof requestId === "string" && IdSchema.safeParse(requestId).success
          ? requestId
          : randomUUID();
      let artifact;
      try {
        artifact = await deps.artifactService.create(
          owner.id,
          projectId,
          {
            type: "workflow-output",
            mimeType: "application/json",
            bytes,
            metadata: {
              sourceExecutionId: executionId,
              sourceContextId: outputContextId,
              toolId: step.toolId,
              // ai_response outputs persist as JSON like any other payload;
              // the 512 KiB cap below applies unchanged.
              sourceOutputType: output.type,
            },
          },
          traceId,
        );
      } catch (error) {
        throw toUploadHttpError(error);
      }
      res.status(201).json({ artifact });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.get("/", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const projectId = projectIdFromParams(req.params);
      const artifacts = await deps.artifactService.list(owner.id, projectId);
      res.json({ artifacts });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.get("/:artifactId", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const projectId = projectIdFromParams(req.params);
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
      const projectId = projectIdFromParams(req.params);
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

      const filename = downloadFilename(
        artifact.metadata as Record<string, unknown>,
        artifact.id,
      );
      res.setHeader("Content-Type", artifact.mimeType);
      res.setHeader("Content-Length", String(bytes.byteLength));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.status(200).send(Buffer.from(bytes));
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  return router;
}
