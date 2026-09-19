import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, JsonMetadataSchema } from "./common.js";
import { WorkflowDefinitionV1Schema } from "./workflow.js";

export const DocumentKindSchema = z.enum(["note", "workflow"]);
export const NoteTitleSchema = z.string().trim().min(1).max(200);
export const NoteContentSchema = z.object({ body: z.string() });

export const WorkflowContentSchema = z.object({
  kind: z.literal("workflow"),
  workflow: WorkflowDefinitionV1Schema,
});

export const CreateNoteRequestSchema = z.object({
  title: NoteTitleSchema,
  body: z.string(),
});

export const UpdateNoteRequestSchema = z.object({
  title: NoteTitleSchema,
  body: z.string(),
  baseRevisionId: IdSchema,
});

export const CreateWorkflowRequestSchema = z.object({
  title: NoteTitleSchema,
  workflow: WorkflowDefinitionV1Schema,
});

export const UpdateWorkflowRequestSchema = z.object({
  title: NoteTitleSchema,
  workflow: WorkflowDefinitionV1Schema,
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

export const WorkflowDocumentRevisionSchema = z.object({
  id: IdSchema,
  documentId: IdSchema,
  revisionNumber: z.number().int().positive(),
  parentRevisionId: IdSchema.nullable(),
  content: WorkflowContentSchema,
  metadata: JsonMetadataSchema,
  createdAt: IsoDateTimeSchema,
});

export const NoteDocumentSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  kind: z.literal("note"),
  title: NoteTitleSchema,
  currentRevisionId: IdSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const WorkflowDocumentSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  kind: z.literal("workflow"),
  title: NoteTitleSchema,
  currentRevisionId: IdSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const NoteDocumentViewSchema = z.object({
  document: NoteDocumentSchema,
  revision: DocumentRevisionSchema,
});

export const WorkflowDocumentViewSchema = z.object({
  document: WorkflowDocumentSchema,
  revision: WorkflowDocumentRevisionSchema,
});

export type DocumentKind = z.infer<typeof DocumentKindSchema>;
export type CreateNoteRequest = z.infer<typeof CreateNoteRequestSchema>;
export type UpdateNoteRequest = z.infer<typeof UpdateNoteRequestSchema>;
export type CreateWorkflowRequest = z.infer<typeof CreateWorkflowRequestSchema>;
export type UpdateWorkflowRequest = z.infer<typeof UpdateWorkflowRequestSchema>;
export type DocumentRevision = z.infer<typeof DocumentRevisionSchema>;
export type WorkflowDocumentRevision = z.infer<
  typeof WorkflowDocumentRevisionSchema
>;
export type NoteDocument = z.infer<typeof NoteDocumentSchema>;
export type WorkflowDocument = z.infer<typeof WorkflowDocumentSchema>;
export type NoteDocumentView = z.infer<typeof NoteDocumentViewSchema>;
export type WorkflowDocumentView = z.infer<typeof WorkflowDocumentViewSchema>;
