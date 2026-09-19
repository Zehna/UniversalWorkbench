import type {
  DocumentRevision,
  NoteDocumentView,
  WorkflowDefinitionV1,
  WorkflowDocumentView,
} from "@uw/contracts";
import type {
  NoteDocumentSummary,
  WorkflowDocumentSummary,
} from "./model.js";

export interface CreateNoteRecordInput {
  ownerId: string;
  projectId: string;
  documentId: string;
  revisionId: string;
  title: string;
  body: string;
  createdAt: Date;
}

export interface UpdateNoteRecordInput {
  ownerId: string;
  projectId: string;
  documentId: string;
  revisionId: string;
  title: string;
  body: string;
  baseRevisionId: string;
  updatedAt: Date;
}

export interface CreateWorkflowRecordInput {
  ownerId: string;
  projectId: string;
  documentId: string;
  revisionId: string;
  title: string;
  workflow: WorkflowDefinitionV1;
  createdAt: Date;
}

export interface UpdateWorkflowRecordInput {
  ownerId: string;
  projectId: string;
  documentId: string;
  revisionId: string;
  title: string;
  workflow: WorkflowDefinitionV1;
  baseRevisionId: string;
  updatedAt: Date;
}

export type UpdateNoteRecordResult =
  | { status: "updated"; value: NoteDocumentView }
  | { status: "not_found" }
  | { status: "conflict"; currentRevisionId: string };

export type UpdateWorkflowRecordResult =
  | { status: "updated"; value: WorkflowDocumentView }
  | { status: "not_found" }
  | { status: "conflict"; currentRevisionId: string };

export interface DocumentRepository {
  projectExists(ownerId: string, projectId: string): Promise<boolean>;
  createNote(input: CreateNoteRecordInput): Promise<NoteDocumentView | null>;
  listNotes(ownerId: string, projectId: string): Promise<NoteDocumentSummary[]>;
  getNote(
    ownerId: string,
    projectId: string,
    documentId: string,
  ): Promise<NoteDocumentView | null>;
  listRevisions(
    ownerId: string,
    projectId: string,
    documentId: string,
  ): Promise<DocumentRevision[] | null>;
  updateNote(input: UpdateNoteRecordInput): Promise<UpdateNoteRecordResult>;

  createWorkflow(
    input: CreateWorkflowRecordInput,
  ): Promise<WorkflowDocumentView | null>;
  listWorkflows(
    ownerId: string,
    projectId: string,
  ): Promise<WorkflowDocumentSummary[]>;
  getWorkflow(
    ownerId: string,
    projectId: string,
    documentId: string,
  ): Promise<WorkflowDocumentView | null>;
  updateWorkflow(
    input: UpdateWorkflowRecordInput,
  ): Promise<UpdateWorkflowRecordResult>;
}
