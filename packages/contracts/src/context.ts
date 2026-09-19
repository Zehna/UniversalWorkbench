import { z } from "zod";
import { IdSchema, SchemaVersionSchema } from "./common.js";

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

export const ContextTypeSchema = z.enum([
  "text",
  "markdown",
  "json",
  "api-response",
  "artifact-ref",
  "note-ref",
  "error",
]);

export const ContextCapabilitySchema = z.string().trim().min(1).max(128);

export const ContextProvenanceSchema = z.object({
  projectId: IdSchema,
  artifactIds: z.array(IdSchema),
  executionId: IdSchema.optional(),
  stepExecutionId: IdSchema.optional(),
  parentContextIds: z.array(IdSchema),
});

export const ContextEnvelopeSchema = z.object({
  id: IdSchema,
  type: ContextTypeSchema,
  schemaVersion: SchemaVersionSchema,
  mimeType: z.string().trim().min(1).max(255),
  metadata: JsonObjectSchema.default({}),
  payload: JsonValueSchema,
  provenance: ContextProvenanceSchema,
  capabilities: z.array(ContextCapabilitySchema).default([]),
});

export type JsonObject = z.infer<typeof JsonObjectSchema>;
export type ContextType = z.infer<typeof ContextTypeSchema>;
export type ContextCapability = z.infer<typeof ContextCapabilitySchema>;
export type ContextProvenance = z.infer<typeof ContextProvenanceSchema>;
export type ContextEnvelope = z.infer<typeof ContextEnvelopeSchema>;
