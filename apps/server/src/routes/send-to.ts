import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ContextEnvelope,
  OwnerPublic,
  SyncOperation,
} from "@uw/contracts";
import { IdSchema } from "@uw/contracts";
import type { AuthService } from "@uw/auth";
import type { DocumentService } from "@uw/documents";
import type { ExecutionRepository } from "@uw/execution";
import type { SyncRepository } from "@uw/sync";
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
  /**
   * When present, server-saved notes also fan out as document.create sync
   * changes so every device pulls them like normal documents. Absent in
   * unit-test compositions, where the note write alone is asserted.
   */
  syncRepository?: SyncRepository;
}

const FromExecutionSchema = z.strictObject({
  executionId: IdSchema,
  outputContextId: IdSchema,
});

function noteBodyFor(output: ContextEnvelope): string {
  if (
    (output.type === "ai_response" || output.type === "agent_response") &&
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
        output.type !== "agent_response" &&
        output.type !== "text" &&
        output.type !== "markdown"
      ) {
        throw new HttpError(
          400,
          "UNSUPPORTED_OUTPUT_TYPE",
          "Only ai_response, agent_response, text, and markdown outputs can be saved as notes",
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
      const title =
        output.type === "ai_response"
          ? "AI result"
          : output.type === "agent_response"
            ? "Agent result"
            : "Workflow output";
      const document = await deps.documentService.createNote(
        owner.id,
        projectId,
        { title, body },
        traceId,
      );
      if (deps.syncRepository) {
        // Fan the server-saved note out as a document.create change so every
        // device pulls it like a normal document. Attribution needs a real
        // device row (sync_operations.device_id is a foreign key); with no
        // registered devices there is nobody to fan out to, so skip.
        const devices = await deps.syncRepository.listDevices(owner.id);
        const active = devices
          .filter((device) => !device.revokedAt)
          .sort((left, right) => (left.lastSeenAt < right.lastSeenAt ? 1 : -1));
        const attributing = active[0];
        if (attributing) {
          const note = JSON.parse(JSON.stringify(document)) as Record<
            string,
            unknown
          >;
          const operation: SyncOperation = {
            id: randomUUID(),
            deviceId: attributing.id,
            projectId,
            entityType: "document",
            entityId: document.document.id,
            action: "document.create",
            baseRevision: null,
            payload: { title, body },
            createdAt: new Date().toISOString(),
          };
          await deps.syncRepository.persistAppliedOperation({
            ownerId: owner.id,
            operation,
            resultRevision: document.revision.id,
            change: {
              kind: "upsert",
              revision: document.revision.id,
              payload: { note },
            },
            now: new Date(),
          });
        }
      }
      res.status(201).json({ document });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  return router;
}
