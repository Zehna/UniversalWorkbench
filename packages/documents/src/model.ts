import type { NoteDocument } from "@uw/contracts";

export type NoteDocumentSummary = NoteDocument;

export class DocumentNotFoundError extends Error {
  constructor(documentId: string) {
    super(`Document not found: ${documentId}`);
    this.name = "DocumentNotFoundError";
  }
}

export class RevisionConflictError extends Error {
  readonly currentRevisionId: string;

  constructor(currentRevisionId: string) {
    super("Document revision conflict");
    this.name = "RevisionConflictError";
    this.currentRevisionId = currentRevisionId;
  }
}
