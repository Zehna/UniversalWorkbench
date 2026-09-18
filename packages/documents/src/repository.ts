import type { DocumentRevision, NoteDocumentView } from "@uw/contracts";
import type { NoteDocumentSummary } from "./model.js";

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

export type UpdateNoteRecordResult =
  | { status: "updated"; value: NoteDocumentView }
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
}
