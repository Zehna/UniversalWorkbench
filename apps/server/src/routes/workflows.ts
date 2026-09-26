import { randomUUID } from "node:crypto";
import {
  ContextEnvelopeSchema,
  IdSchema,
  WorkflowDefinitionSchema,
} from "@uw/contracts";
import type { AuthService } from "@uw/auth";
import type { OwnerPublic } from "@uw/contracts";
import type { WorkflowService } from "@uw/workflow";
import { Router } from "express";
import { z } from "zod";
import { requireOwner, type SessionCookieConfig } from "../middleware/auth.js";
import { parseRequest } from "../middleware/validate.js";
import { mapWorkflowHttpError } from "../middleware/workflow-errors.js";

const SaveRequestSchema = z.strictObject({
  definition: WorkflowDefinitionSchema,
  expectedVersion: z.number().int().nonnegative().optional(),
});

const RunRequestSchema = z.strictObject({
  input: ContextEnvelopeSchema,
  budget: z
    .strictObject({
      maxSteps: z.number().int().min(1).max(10_000),
      maxDurationMs: z.number().int().min(1).max(3_600_000),
      maxOutputBytes: z.number().int().min(1).max(104_857_600),
    })
    .optional(),
});

function scope(res: { locals: Record<string, unknown> }, params: object) {
  const owner = res.locals.owner as OwnerPublic;
  const projectId = parseRequest(
    IdSchema,
    (params as Record<string, unknown>).projectId,
  );
  return { ownerId: owner.id, projectId };
}

export function createWorkflowsRouter(deps: {
  authService: AuthService;
  sessionCookie: SessionCookieConfig;
  service: WorkflowService;
}) {
  const router = Router({ mergeParams: true });
  router.use(requireOwner(deps.authService, deps.sessionCookie));

  router.get("/", async (req, res, next) => {
    try {
      const { ownerId, projectId } = scope(res, req.params);
      const workflows = await deps.service.list(ownerId, projectId);
      res.json({ workflows });
    } catch (error) {
      next(mapWorkflowHttpError(error));
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const { ownerId, projectId } = scope(res, req.params);
      const request = parseRequest(SaveRequestSchema, req.body);
      const saved = await deps.service.save(
        ownerId,
        projectId,
        request.definition,
        request.expectedVersion,
      );
      res.status(saved.version === 1 ? 201 : 200).json({ workflow: saved });
    } catch (error) {
      next(mapWorkflowHttpError(error));
    }
  });

  router.get("/:workflowId", async (req, res, next) => {
    try {
      const { ownerId, projectId } = scope(res, req.params);
      const workflowId = parseRequest(IdSchema, req.params.workflowId);
      const workflow = await deps.service.get(ownerId, projectId, workflowId);
      res.json({ workflow });
    } catch (error) {
      next(mapWorkflowHttpError(error));
    }
  });

  router.post("/:workflowId/executions", async (req, res, next) => {
    try {
      const { ownerId, projectId } = scope(res, req.params);
      const workflowId = parseRequest(IdSchema, req.params.workflowId);
      const request = parseRequest(RunRequestSchema, req.body);
      const requestId = String(res.locals.requestId);
      // Execution trace column is UUID; preserve a UUID request ID when present.
      const traceId = IdSchema.safeParse(requestId).success
        ? requestId
        : randomUUID();
      const execution = await deps.service.run({
        ownerId,
        projectId,
        workflowId,
        context: request.input,
        traceId,
        ...(request.budget ? { budget: request.budget } : {}),
      });
      res
        .status(202)
        .json({
          executionId: execution.id,
          status: execution.status,
          traceId: execution.traceId,
        });
    } catch (error) {
      next(mapWorkflowHttpError(error));
    }
  });

  return router;
}
