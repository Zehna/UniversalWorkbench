import { Router } from "express";
import type { OwnerPublic } from "@uw/contracts";
import {
  CreateNoteRequestSchema,
  IdSchema,
  UpdateNoteRequestSchema,
} from "@uw/contracts";
import type { AuthService } from "@uw/auth";
import type { DocumentService } from "@uw/documents";
import {
  requireOwner,
  type SessionCookieConfig,
} from "../middleware/auth.js";
import { mapDomainError, parseRequest } from "../middleware/validate.js";

interface DocumentRouterDependencies {
  authService: AuthService;
  sessionCookie: SessionCookieConfig;
  documentService: DocumentService;
}

function ownerFromLocals(locals: Record<string, unknown>): OwnerPublic {
  return locals.owner as OwnerPublic;
}

function traceIdFromLocals(locals: Record<string, unknown>): string {
  return String(locals.requestId);
}

function projectIdFromParams(params: object): string {
  return parseRequest(
    IdSchema,
    (params as Record<string, unknown>).projectId,
  );
}

export function createDocumentsRouter(deps: DocumentRouterDependencies) {
  const router = Router({ mergeParams: true });
  router.use(requireOwner(deps.authService, deps.sessionCookie));

  router.get("/", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const projectId = projectIdFromParams(req.params);
      const documents = await deps.documentService.listNotes(
        owner.id,
        projectId,
      );
      res.json({ documents });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const projectId = projectIdFromParams(req.params);
      const input = parseRequest(CreateNoteRequestSchema, req.body);
      const document = await deps.documentService.createNote(
        owner.id,
        projectId,
        input,
        traceIdFromLocals(res.locals),
      );
      res.status(201).json(document);
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.get("/:documentId", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const projectId = projectIdFromParams(req.params);
      const documentId = parseRequest(IdSchema, req.params.documentId);
      const document = await deps.documentService.getNote(
        owner.id,
        projectId,
        documentId,
      );
      res.json(document);
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.patch("/:documentId", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const projectId = projectIdFromParams(req.params);
      const documentId = parseRequest(IdSchema, req.params.documentId);
      const input = parseRequest(UpdateNoteRequestSchema, req.body);
      const document = await deps.documentService.updateNote(
        owner.id,
        projectId,
        documentId,
        input,
        traceIdFromLocals(res.locals),
      );
      res.json(document);
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  router.get("/:documentId/revisions", async (req, res, next) => {
    try {
      const owner = ownerFromLocals(res.locals);
      const projectId = projectIdFromParams(req.params);
      const documentId = parseRequest(IdSchema, req.params.documentId);
      const revisions = await deps.documentService.listRevisions(
        owner.id,
        projectId,
        documentId,
      );
      res.json({ revisions });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  return router;
}
