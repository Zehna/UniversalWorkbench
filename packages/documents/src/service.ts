import {
  WorkflowDefinitionV1Schema,
  type CreateNoteRequest,
  type CreateWorkflowRequest,
  type DocumentRevision,
  type NoteDocumentView,
  type UpdateNoteRequest,
  type UpdateWorkflowRequest,
  type WorkflowDefinitionV1,
  type WorkflowDocumentView,
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
  type WorkflowDocumentSummary,
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

  createWorkflow(
    ownerId: string,
    projectId: string,
    input: CreateWorkflowRequest,
    traceId: string,
  ): Promise<WorkflowDocumentView>;
  updateWorkflow(
    ownerId: string,
    projectId: string,
    documentId: string,
    input: UpdateWorkflowRequest,
    traceId: string,
  ): Promise<WorkflowDocumentView>;
  listWorkflows(
    ownerId: string,
    projectId: string,
  ): Promise<WorkflowDocumentSummary[]>;
  getWorkflow(
    ownerId: string,
    projectId: string,
    documentId: string,
  ): Promise<WorkflowDocumentView>;
  assertCanonicalWorkflowRevision(
    ownerId: string,
    projectId: string,
    documentId: string,
    revisionId: string,
  ): Promise<WorkflowDocumentView>;
}

export interface CreateDocumentServiceOptions {
  documents: DocumentRepository;
  audit: AuditRepository;
  clock: Clock;
  idGenerator: IdGenerator;
  validateWorkflow?: (definition: WorkflowDefinitionV1) => void;
}

const NOTE_FIELDS = ["body", "title"] as const;
const WORKFLOW_FIELDS = ["title", "workflow"] as const;

export function createDocumentService(
  options: CreateDocumentServiceOptions,
): DocumentService {
  const { documents, audit, clock, idGenerator } = options;
  const validateWorkflow =
    options.validateWorkflow ??
    ((definition: WorkflowDefinitionV1) => {
      WorkflowDefinitionV1Schema.parse(definition);
    });

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

    async createWorkflow(ownerId, projectId, input, traceId) {
      validateWorkflow(input.workflow);
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
          const created = await documents.createWorkflow({
            ownerId,
            projectId,
            documentId: idGenerator.next(),
            revisionId: idGenerator.next(),
            title: input.title,
            workflow: structuredClone(input.workflow),
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
            metadata: {
              kind: "workflow",
              fields: [...WORKFLOW_FIELDS],
            },
            createdAt: clock.now(),
          });
        },
      });
    },

    async updateWorkflow(ownerId, projectId, documentId, input, traceId) {
      validateWorkflow(input.workflow);
      return executeAction({
        name: "document.update",
        input,
        context: { actorId: ownerId, projectId, traceId },
        authorize: async () => {
          if (!(await documents.getWorkflow(ownerId, projectId, documentId))) {
            throw new DocumentNotFoundError(documentId);
          }
        },
        run: async () => {
          const result = await documents.updateWorkflow({
            ownerId,
            projectId,
            documentId,
            revisionId: idGenerator.next(),
            title: input.title,
            workflow: structuredClone(input.workflow),
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
            metadata: {
              kind: "workflow",
              fields: [...WORKFLOW_FIELDS],
            },
            createdAt: clock.now(),
          });
        },
      });
    },

    listWorkflows(ownerId, projectId) {
      return documents.listWorkflows(ownerId, projectId);
    },

    async getWorkflow(ownerId, projectId, documentId) {
      const workflow = await documents.getWorkflow(
        ownerId,
        projectId,
        documentId,
      );
      if (!workflow) throw new DocumentNotFoundError(documentId);
      return workflow;
    },

    async assertCanonicalWorkflowRevision(
      ownerId,
      projectId,
      documentId,
      revisionId,
    ) {
      const workflow = await documents.getWorkflow(
        ownerId,
        projectId,
        documentId,
      );
      if (!workflow) throw new DocumentNotFoundError(documentId);
      if (workflow.revision.id !== revisionId) {
        throw new RevisionConflictError(workflow.revision.id);
      }
      return workflow;
    },
  };
}
