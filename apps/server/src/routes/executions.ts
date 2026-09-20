import type { AuthService } from "@uw/auth";
import {
  ExecutionBudgetSchema,
  IdSchema,
  JsonObjectSchema,
  ToolReferenceSchema,
  type Execution,
  type OwnerPublic,
} from "@uw/contracts";
import type {
  DirectToolExecutionService,
  ExecutionService,
} from "@uw/execution";
import { DEFAULT_EXECUTION_BUDGET } from "@uw/execution";
import type { WorkflowService } from "@uw/workflow";
import { Router } from "express";
import { z } from "zod";
import { requireOwner, type SessionCookieConfig } from "../middleware/auth.js";
import { HttpError, mapDomainError, parseRequest } from "../middleware/validate.js";

export type { DirectToolExecutionService } from "@uw/execution";

export interface ExecutionApiService extends ExecutionService {
  list(ownerId: string, projectId: string): Promise<Execution[]>;
}

interface ExecutionsRouterDependencies {
  authService: AuthService;
  sessionCookie: SessionCookieConfig;
  executionService: ExecutionApiService;
  workflowService: WorkflowService;
  directToolExecutionService: DirectToolExecutionService;
}

const ProjectParamsSchema = z.object({
  projectId: IdSchema,
});

const ExecutionParamsSchema = z.object({
  projectId: IdSchema,
  executionId: IdSchema,
});

const CommonExecutionFields = {
  idempotencyKey: z.string().trim().min(1).max(256),
  budget: ExecutionBudgetSchema.optional(),
};

const CreateExecutionRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workflow"),
    workflowId: IdSchema,
    workflowRevisionId: IdSchema,
    ...CommonExecutionFields,
  }),
  z.object({
    kind: z.literal("tool"),
    tool: ToolReferenceSchema,
    config: JsonObjectSchema,
    ...CommonExecutionFields,
  }),
]);

function ownerFromLocals(locals: Record<string, unknown>): OwnerPublic {
  return locals.owner as OwnerPublic;
}

async function ownedExecution(
  service: ExecutionApiService,
  ownerId: string,
  projectId: string,
  executionId: string,
) {
  const execution = await service.get(ownerId, executionId);
  if (!execution || execution.projectId !== projectId) {
    throw new HttpError(404, "NOT_FOUND", "Resource not found");
  }
  return execution;
}

export function createExecutionsRouter(deps: ExecutionsRouterDependencies) {
  const router = Router({ mergeParams: true });
  router.use(requireOwner(deps.authService, deps.sessionCookie));

  router.get("/", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const { projectId } = parseRequest(ProjectParamsSchema, req.params);
      const executions = await deps.executionService.list(owner.id, projectId);
      res.json({ executions });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const { projectId } = parseRequest(ProjectParamsSchema, req.params);
      const input = parseRequest(CreateExecutionRequestSchema, req.body);

      if (input.kind === "workflow") {
        const result = await deps.workflowService.enqueueRun({
          ownerId: owner.id,
          projectId,
          workflowId: input.workflowId,
          workflowRevisionId: input.workflowRevisionId,
          idempotencyKey: input.idempotencyKey,
          budget: input.budget ?? DEFAULT_EXECUTION_BUDGET,
        });
        res.status(202).json(result);
        return;
      }

      const result = await deps.directToolExecutionService.enqueueToolRun({
        ownerId: owner.id,
        projectId,
        idempotencyKey: input.idempotencyKey,
        tool: input.tool,
        config: input.config,
        ...(input.budget === undefined ? {} : { budget: input.budget }),
      });
      res.status(202).json(result);
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.get("/:executionId", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const { projectId, executionId } = parseRequest(
        ExecutionParamsSchema,
        req.params,
      );
      const execution = await ownedExecution(
        deps.executionService,
        owner.id,
        projectId,
        executionId,
      );
      res.json({ execution });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.post("/:executionId/cancel", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const { projectId, executionId } = parseRequest(
        ExecutionParamsSchema,
        req.params,
      );
      await ownedExecution(
        deps.executionService,
        owner.id,
        projectId,
        executionId,
      );
      const execution = await deps.executionService.requestCancellation(
        owner.id,
        executionId,
      );
      if (!execution) {
        throw new HttpError(404, "NOT_FOUND", "Resource not found");
      }
      res.json({ execution });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.get("/:executionId/receipt", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const { projectId, executionId } = parseRequest(
        ExecutionParamsSchema,
        req.params,
      );
      await ownedExecution(
        deps.executionService,
        owner.id,
        projectId,
        executionId,
      );
      const [receipts, provenance] = await Promise.all([
        deps.executionService.listReceipts(owner.id, executionId),
        deps.executionService.listProvenance(owner.id, executionId),
      ]);
      res.json({ receipts, provenance });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  return router;
}
