import type { NoteDocumentView } from "@uw/contracts";
import {
  executeAction,
  ProjectNotFoundError,
  type AuditRepository,
} from "@uw/core";
import type { Clock, IdGenerator } from "@uw/shared";
import type { DocumentRepository } from "./repository.js";

export interface ExecutionNoteInput {
  documentId: string;
  revisionId: string;
  title: string;
  body: string;
}

export interface ExecutionNoteWriter {
  createNote(
    ownerId: string,
    projectId: string,
    input: ExecutionNoteInput,
    traceId: string,
  ): Promise<NoteDocumentView>;
}

export interface CreateExecutionNoteWriterOptions {
  documents: DocumentRepository;
  audit: AuditRepository;
  clock: Clock;
  idGenerator: IdGenerator;
}

export function createExecutionNoteWriter(
  options: CreateExecutionNoteWriterOptions,
): ExecutionNoteWriter {
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
          const created = await documents.createNote({
            ownerId,
            projectId,
            documentId: input.documentId,
            revisionId: input.revisionId,
            title: input.title,
            body: input.body,
            createdAt: clock.now(),
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
            metadata: {
              fields: ["body", "title"],
              source: "execution",
            },
            createdAt: clock.now(),
          });
        },
      });
    },
  };
}
