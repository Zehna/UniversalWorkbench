import type {
  CreateNoteRequest,
  DocumentRevision,
  NoteDocumentView,
  UpdateNoteRequest,
} from "@uw/contracts";
import {
  executeAction,
  ProjectNotFoundError,
  type AuditRepository,
} from "@uw/core";
import type { Clock, IdGenerator } from "@uw/shared";
import {
  DocumentNotFoundError,
  RevisionConflictError,
  type NoteDocumentSummary,
} from "./model.js";
import type { DocumentRepository } from "./repository.js";

export interface DocumentService {
  createNote(
    ownerId: string,
    projectId: string,
    input: CreateNoteRequest,
    traceId: string,
  ): Promise<NoteDocumentView>;
  updateNote(
    ownerId: string,
    projectId: string,
    documentId: string,
    input: UpdateNoteRequest,
    traceId: string,
  ): Promise<NoteDocumentView>;
  listNotes(ownerId: string, projectId: string): Promise<NoteDocumentSummary[]>;
  getNote(
    ownerId: string,
    projectId: string,
    documentId: string,
  ): Promise<NoteDocumentView>;
  listRevisions(
    ownerId: string,
    projectId: string,
    documentId: string,
  ): Promise<DocumentRevision[]>;
}

export interface CreateDocumentServiceOptions {
  documents: DocumentRepository;
  audit: AuditRepository;
  clock: Clock;
  idGenerator: IdGenerator;
}

const NOTE_FIELDS = ["body", "title"] as const;

export function createDocumentService(
  options: CreateDocumentServiceOptions,
): DocumentService {
  const { documents, audit, clock, idGenerator } = options;

  return {
    async createNote(ownerId, projectId, input, traceId) {
      return executeAction({
        name: "document.create",
        input,
        context: { actorId: ownerId, projectId, traceId },
        authorize: async () => {
          if (!(await documents.projectExists(ownerId, projectId))) {
            throw new ProjectNotFoundError(projectId);
          }
        },
        run: async () => {
          const createdAt = clock.now();
          const created = await documents.createNote({
            ownerId,
            projectId,
            documentId: idGenerator.next(),
            revisionId: idGenerator.next(),
            title: input.title,
            body: input.body,
            createdAt,
          });
          if (!created) throw new ProjectNotFoundError(projectId);
          return created;
        },
        audit: async (created) => {
          await audit.record({
            id: idGenerator.next(),
            actorId: ownerId,
            projectId,
            action: "document.create",
            targetType: "document",
            targetId: created.document.id,
            traceId,
            metadata: { fields: [...NOTE_FIELDS] },
            createdAt: clock.now(),
          });
        },
      });
    },

    async updateNote(ownerId, projectId, documentId, input, traceId) {
      return executeAction({
        name: "document.update",
        input,
        context: { actorId: ownerId, projectId, traceId },
        authorize: async () => {
          if (!(await documents.getNote(ownerId, projectId, documentId))) {
            throw new DocumentNotFoundError(documentId);
          }
        },
        run: async () => {
          const result = await documents.updateNote({
            ownerId,
            projectId,
            documentId,
            revisionId: idGenerator.next(),
            title: input.title,
            body: input.body,
            baseRevisionId: input.baseRevisionId,
            updatedAt: clock.now(),
          });

          if (result.status === "not_found") {
            throw new DocumentNotFoundError(documentId);
          }
          if (result.status === "conflict") {
            throw new RevisionConflictError(result.currentRevisionId);
          }
          return result.value;
        },
        audit: async (updated) => {
          await audit.record({
            id: idGenerator.next(),
            actorId: ownerId,
            projectId,
            action: "document.update",
            targetType: "document",
            targetId: updated.document.id,
            traceId,
            metadata: { fields: [...NOTE_FIELDS] },
            createdAt: clock.now(),
          });
        },
      });
    },

    async listNotes(ownerId, projectId) {
      return documents.listNotes(ownerId, projectId);
    },

    async getNote(ownerId, projectId, documentId) {
      const note = await documents.getNote(ownerId, projectId, documentId);
      if (!note) throw new DocumentNotFoundError(documentId);
      return note;
    },

    async listRevisions(ownerId, projectId, documentId) {
      const revisions = await documents.listRevisions(
        ownerId,
        projectId,
        documentId,
      );
      if (!revisions) throw new DocumentNotFoundError(documentId);
      return revisions;
    },
  };
}
