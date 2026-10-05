import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ContextEnvelope, OwnerPublic } from "@uw/contracts";
import { IdSchema } from "@uw/contracts";
import type { AuthService } from "@uw/auth";
import type { DocumentService } from "@uw/documents";
import type { ExecutionRepository } from "@uw/execution";
import { requireOwner, type SessionCookieConfig } from "../middleware/auth.js";
import {
  HttpError,
  mapDomainError,
  parseRequest,
} from "../middleware/validate.js";

interface SendToRouterDependencies {
  authService: AuthService;
  sessionCookie: SessionCookieConfig;
  documentService: DocumentService;
  executionRepository: ExecutionRepository;
}

const FromExecutionSchema = z.strictObject({
  executionId: IdSchema,
  outputContextId: IdSchema,
});

function noteBodyFor(output: ContextEnvelope): string {
  if (
    output.type === "ai_response" &&
    output.payload !== null &&
    typeof output.payload === "object" &&
    "text" in output.payload &&
    typeof (output.payload as { text: unknown }).text === "string"
  ) {
    return (output.payload as { text: string }).text;
  }
  if (typeof output.payload === "string") return output.payload;
  const serialized = JSON.stringify(output.payload);
  return serialized ?? "";
}

export function createSendToRouter(deps: SendToRouterDependencies) {
  const router = Router({ mergeParams: true });
  router.use(requireOwner(deps.authService, deps.sessionCookie));

  router.post("/documents/from-execution", async (req, res, next) => {
    try {
      const owner = res.locals.owner as OwnerPublic;
      const projectId = parseRequest(
        IdSchema,
        (req.params as Record<string, unknown>).projectId,
      );
      const { executionId, outputContextId } = parseRequest(
        FromExecutionSchema,
        req.body,
      );
      // Note content comes exclusively from a completed, owner-scoped
      // execution record, never from client-submitted bytes.
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
      if (
        output.type !== "ai_response" &&
        output.type !== "text" &&
        output.type !== "markdown"
      ) {
        throw new HttpError(
          400,
          "UNSUPPORTED_OUTPUT_TYPE",
          "Only ai_response, text, and markdown outputs can be saved as notes",
        );
      }
      const body = noteBodyFor(output);
      if (new TextEncoder().encode(body).byteLength > 524288) {
        throw new HttpError(413, "OUTPUT_TOO_LARGE", "Output exceeds 512 KB");
      }
      const requestId = res.locals.requestId;
      const traceId =
        typeof requestId === "string" && IdSchema.safeParse(requestId).success
          ? requestId
          : randomUUID();
      const document = await deps.documentService.createNote(
        owner.id,
        projectId,
        {
          title:
            output.type === "ai_response"
              ? "AI result"
              : "Workflow output",
          body,
        },
        traceId,
      );
      res.status(201).json({ document });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  return router;
}
