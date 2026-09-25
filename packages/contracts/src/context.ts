import { z } from "zod";
import { IdSchema, JsonMetadataSchema } from "./common.js";

export const ContextTypeSchema = z.enum([
  "text",
  "markdown",
  "json",
  "api_response",
  "artifact_ref",
]);

export const ContextProvenanceSchema = z.object({
  executionId: IdSchema.optional(),
  stepId: IdSchema.optional(),
  sourceContextIds: z.array(IdSchema),
});

export const ContextEnvelopeSchema = z.object({
  id: IdSchema,
  type: ContextTypeSchema,
  schemaVersion: z.literal(1),
  mimeType: z.string().trim().min(1).max(255),
  metadata: JsonMetadataSchema,
  payload: z.unknown(),
  provenance: ContextProvenanceSchema,
  capabilities: z.array(z.string().trim().min(1).max(128)),
});

export type ContextType = z.infer<typeof ContextTypeSchema>;
export type ContextProvenance = z.infer<typeof ContextProvenanceSchema>;
export type ContextEnvelope<T = unknown> = Omit<
  z.infer<typeof ContextEnvelopeSchema>,
  "payload"
> & { payload: T };
