import { z } from "zod";
import {
  IdSchema,
  IsoDateTimeSchema,
  JsonMetadataSchema,
} from "./common.js";

export const DocumentKindSchema = z.literal("note");
export const NoteTitleSchema = z.string().trim().min(1).max(200);
export const NoteContentSchema = z.object({ body: z.string() });

export const CreateNoteRequestSchema = z.object({
  title: NoteTitleSchema,
  body: z.string(),
});

export const UpdateNoteRequestSchema = z.object({
  title: NoteTitleSchema,
  body: z.string(),
  baseRevisionId: IdSchema,
});

export const DocumentRevisionSchema = z.object({
  id: IdSchema,
  documentId: IdSchema,
  revisionNumber: z.number().int().positive(),
  parentRevisionId: IdSchema.nullable(),
  content: NoteContentSchema,
  metadata: JsonMetadataSchema,
  createdAt: IsoDateTimeSchema,
});

export const NoteDocumentSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  kind: DocumentKindSchema,
  title: NoteTitleSchema,
  currentRevisionId: IdSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const NoteDocumentViewSchema = z.object({
  document: NoteDocumentSchema,
  revision: DocumentRevisionSchema,
});

export type DocumentKind = z.infer<typeof DocumentKindSchema>;
export type CreateNoteRequest = z.infer<typeof CreateNoteRequestSchema>;
export type UpdateNoteRequest = z.infer<typeof UpdateNoteRequestSchema>;
export type DocumentRevision = z.infer<typeof DocumentRevisionSchema>;
export type NoteDocument = z.infer<typeof NoteDocumentSchema>;
export type NoteDocumentView = z.infer<typeof NoteDocumentViewSchema>;
