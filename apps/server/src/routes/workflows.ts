import type { AuthService } from "@uw/auth";
import {
  CreateWorkflowRequestSchema,
  ExecutionBudgetSchema,
  IdSchema,
  UpdateWorkflowRequestSchema,
  type OwnerPublic,
} from "@uw/contracts";
import type { DocumentService } from "@uw/documents";
import { DEFAULT_EXECUTION_BUDGET } from "@uw/execution";
import type { WorkflowService } from "@uw/workflow";
import { Router } from "express";
import { z } from "zod";
import { requireOwner, type SessionCookieConfig } from "../middleware/auth.js";
import { mapDomainError, parseRequest } from "../middleware/validate.js";

interface WorkflowsRouterDependencies {
  authService: AuthService;
  sessionCookie: SessionCookieConfig;
  documentService: DocumentService;
  workflowService: WorkflowService;
}

const WorkflowParamsSchema = z.object({
  projectId: IdSchema,
  workflowId: IdSchema,
});

const ProjectParamsSchema = z.object({
  projectId: IdSchema,
});

const ValidateWorkflowRequestSchema = z.object({
  workflowRevisionId: IdSchema,
  budget: ExecutionBudgetSchema.optional(),
});

function ownerFromLocals(locals: Record<string, unknown>): OwnerPublic {
  return locals.owner as OwnerPublic;
}

function traceIdFromLocals(locals: Record<string, unknown>): string {
  return String(locals.requestId);
}

export function createWorkflowsRouter(deps: WorkflowsRouterDependencies) {
  const router = Router({ mergeParams: true });
  router.use(requireOwner(deps.authService, deps.sessionCookie));

  router.get("/", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const { projectId } = parseRequest(ProjectParamsSchema, req.params);
      const workflows = await deps.documentService.listWorkflows(
        owner.id,
        projectId,
      );
      res.json({ workflows });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const { projectId } = parseRequest(ProjectParamsSchema, req.params);
      const input = parseRequest(CreateWorkflowRequestSchema, req.body);
      const workflow = await deps.documentService.createWorkflow(
        owner.id,
        projectId,
        input,
        traceIdFromLocals(res.locals),
      );
      res.status(201).json({ workflow });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.get("/:workflowId", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const { projectId, workflowId } = parseRequest(
        WorkflowParamsSchema,
        req.params,
      );
      const workflow = await deps.documentService.getWorkflow(
        owner.id,
        projectId,
        workflowId,
      );
      res.json({ workflow });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.patch("/:workflowId", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const { projectId, workflowId } = parseRequest(
        WorkflowParamsSchema,
        req.params,
      );
      const input = parseRequest(UpdateWorkflowRequestSchema, req.body);
      const workflow = await deps.documentService.updateWorkflow(
        owner.id,
        projectId,
        workflowId,
        input,
        traceIdFromLocals(res.locals),
      );
      res.json({ workflow });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.post("/:workflowId/validate", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const { projectId, workflowId } = parseRequest(
        WorkflowParamsSchema,
        req.params,
      );
      const input = parseRequest(ValidateWorkflowRequestSchema, req.body);
      const workflow = await deps.workflowService.validateRevision({
        ownerId: owner.id,
        projectId,
        workflowId,
        workflowRevisionId: input.workflowRevisionId,
        budget: input.budget ?? DEFAULT_EXECUTION_BUDGET,
      });
      res.json({ workflow, valid: true });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  return router;
}
