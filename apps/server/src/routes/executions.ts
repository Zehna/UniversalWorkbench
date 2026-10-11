import { Router } from "express";
import type { AuthService } from "@uw/auth";
import type { OwnerPublic } from "@uw/contracts";
import { IdSchema } from "@uw/contracts";
import type { ExecutionRepository, ExecutionView } from "@uw/execution";
import type { WorkflowEngine } from "@uw/execution";
import { z } from "zod";
import { requireOwner, type SessionCookieConfig } from "../middleware/auth.js";
import { HttpError, parseRequest } from "../middleware/validate.js";
import { mapWorkflowHttpError } from "../middleware/workflow-errors.js";

const RejectBodySchema = z
  .object({
    reason: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

function isTerminalStatus(status: string): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function buildExecutionEvents(view: ExecutionView): unknown[] {
  const events: unknown[] = [];
  events.push({
    type: "execution",
    executionId: view.execution.id,
    status: view.execution.status,
    projectId: view.execution.projectId,
  });
  for (const step of view.steps) {
    events.push({
      type: "step",
      stepId: step.id,
      nodeId: step.nodeId,
      toolId: step.toolId,
      status: step.status,
      attempt: step.attempt,
    });
    for (const output of step.outputContexts) {
      if (output.type !== "agent_response") continue;
      const payload = output.payload as {
        text?: unknown;
        status?: unknown;
        trace?: unknown;
        structured?: { pendingApprovals?: unknown };
      };
      if (Array.isArray(payload.trace)) {
        for (const item of payload.trace) {
          const entry =
            item !== null && typeof item === "object"
              ? (item as Record<string, unknown>)
              : {};
          const kind =
            typeof entry["type"] === "string"
              ? (entry["type"] as string)
              : "thought";
          events.push({
            type: kind,
            stepId: step.id,
            outputContextId: output.id,
            ...(typeof entry["iteration"] === "number"
              ? { iteration: entry["iteration"] }
              : {}),
            ...(typeof entry["thought"] === "string"
              ? { thought: entry["thought"] }
              : {}),
            ...(entry["toolCall"] !== undefined
              ? { toolCall: entry["toolCall"] }
              : {}),
            ...(entry["observation"] !== undefined
              ? { observation: entry["observation"] }
              : {}),
          });
          const nested =
            entry["nestedTrace"] !== null &&
            typeof entry["nestedTrace"] === "object" &&
            !Array.isArray(entry["nestedTrace"])
              ? (entry["nestedTrace"] as Record<string, unknown>)
              : null;
          if (nested) {
            const subAgentId =
              typeof nested["subAgentId"] === "string"
                ? (nested["subAgentId"] as string)
                : undefined;
            const role =
              typeof nested["role"] === "string"
                ? (nested["role"] as string)
                : undefined;
            if (subAgentId !== undefined && role !== undefined) {
              events.push({
                type: "sub_agent_turn",
                stepId: step.id,
                outputContextId: output.id,
                subAgentId,
                role,
                ...(typeof nested["status"] === "string"
                  ? { status: nested["status"] }
                  : {}),
                ...(nested["usage"] !== undefined
                  ? { usage: nested["usage"] }
                  : {}),
              });
              if (Array.isArray(nested["trace"])) {
                for (const nestedItem of nested["trace"] as unknown[]) {
                  const nestedEntry =
                    nestedItem !== null && typeof nestedItem === "object"
                      ? (nestedItem as Record<string, unknown>)
                      : {};
                  const nestedKind =
                    typeof nestedEntry["type"] === "string"
                      ? (nestedEntry["type"] as string)
                      : "thought";
                  events.push({
                    type: nestedKind,
                    stepId: step.id,
                    outputContextId: output.id,
                    subAgentId,
                    role,
                    ...(typeof nestedEntry["iteration"] === "number"
                      ? { iteration: nestedEntry["iteration"] }
                      : {}),
                    ...(typeof nestedEntry["thought"] === "string"
                      ? { thought: nestedEntry["thought"] }
                      : {}),
                    ...(nestedEntry["toolCall"] !== undefined
                      ? { toolCall: nestedEntry["toolCall"] }
                      : {}),
                    ...(nestedEntry["observation"] !== undefined
                      ? { observation: nestedEntry["observation"] }
                      : {}),
                  });
                }
              }
            }
          }
        }
      }
      const pending = payload.structured?.pendingApprovals;
      if (payload.status === "awaiting_approval" && Array.isArray(pending)) {
        events.push({
          type: "approval_needed",
          stepId: step.id,
          outputContextId: output.id,
          pendingApprovals: pending,
        });
      }
      events.push({
        type: "agent_response",
        stepId: step.id,
        outputContextId: output.id,
        status: payload.status,
        text: payload.text,
      });
    }
  }
  events.push({
    type: "completed",
    executionId: view.execution.id,
    status: view.execution.status,
  });
  return events;
}

export function createExecutionsRouter(deps: {
  authService: AuthService;
  sessionCookie: SessionCookieConfig;
  repository: ExecutionRepository;
  engine?: Pick<WorkflowEngine, "resolveApproval">;
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
  router.post("/:executionId/approve", async (req, res, next) => {
    try {
      if (
        req.body !== undefined &&
        (typeof req.body !== "object" ||
          req.body === null ||
          Array.isArray(req.body) ||
          Object.keys(req.body as object).length > 0)
      ) {
        throw new HttpError(
          400,
          "BAD_REQUEST",
          "Approval does not accept a request body",
        );
      }
      const view = await scoped(req, res.locals);
      if (view.execution.status !== "awaiting_approval") {
        throw new HttpError(
          409,
          "EXECUTION_NOT_AWAITING_APPROVAL",
          "Execution is not awaiting approval",
        );
      }
      if (!deps.engine) {
        throw new HttpError(
          500,
          "INTERNAL_ERROR",
          "Approval resolution is unavailable",
        );
      }
      const resolved = await deps.engine.resolveApproval(view.execution.id, {
        decision: "approved",
      });
      res.json(resolved);
    } catch (error) {
      next(mapWorkflowHttpError(error));
    }
  });

  router.post("/:executionId/reject", async (req, res, next) => {
    try {
      const rawBody =
        req.body === undefined || req.body === null ? {} : req.body;
      const parsed = RejectBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        throw new HttpError(400, "BAD_REQUEST", "Invalid rejection body");
      }
      const view = await scoped(req, res.locals);
      if (view.execution.status !== "awaiting_approval") {
        throw new HttpError(
          409,
          "EXECUTION_NOT_AWAITING_APPROVAL",
          "Execution is not awaiting approval",
        );
      }
      if (!deps.engine) {
        throw new HttpError(
          500,
          "INTERNAL_ERROR",
          "Approval resolution is unavailable",
        );
      }
      const rejectionReason = parsed.data.reason ?? "Rejected by user";
      const resolved = await deps.engine.resolveApproval(view.execution.id, {
        decision: "rejected",
        rejectionReason,
      });
      res.json(resolved);
    } catch (error) {
      next(mapWorkflowHttpError(error));
    }
  });

  router.get("/:executionId/events", async (req, res, next) => {
    try {
      const view = await scoped(req, res.locals);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const send = (payload: unknown): boolean => {
        if (res.writableEnded || res.destroyed) return false;
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        return true;
      };
      for (const event of buildExecutionEvents(view)) {
        if (!send(event)) return;
      }
      if (isTerminalStatus(view.execution.status)) {
        res.end();
        return;
      }
      const owner = res.locals.owner as OwnerPublic;
      const projectId = view.execution.projectId;
      const executionId = view.execution.id;
      let lastStatus = view.execution.status;
      let lastSteps = view.steps.length;
      const startedAt = Date.now();
      while (
        Date.now() - startedAt < 2000 &&
        !res.writableEnded &&
        !res.destroyed &&
        !(req.destroyed || req.closed)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (res.writableEnded || res.destroyed) break;
        const latest = await deps.repository.get(
          owner.id,
          projectId,
          executionId,
        );
        if (!latest) break;
        if (
          latest.execution.status !== lastStatus ||
          latest.steps.length !== lastSteps
        ) {
          lastStatus = latest.execution.status;
          lastSteps = latest.steps.length;
          if (
            !send({
              type: "status",
              executionId,
              status: latest.execution.status,
              steps: latest.steps.length,
            })
          ) {
            break;
          }
        }
        if (isTerminalStatus(latest.execution.status)) {
          for (const event of buildExecutionEvents(latest).slice(-1)) {
            send(event);
          }
          break;
        }
      }
      if (!res.writableEnded && !res.destroyed) res.end();
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      next(mapWorkflowHttpError(error));
    }
  });
  return router;
}
