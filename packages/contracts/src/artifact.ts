import { z } from "zod";
import {
  IdSchema,
  IsoDateTimeSchema,
  JsonMetadataSchema,
  SchemaVersionSchema,
} from "./common.js";

export const ArtifactTypeSchema = z.string().trim().min(1).max(64);
export const MimeTypeSchema = z.string().trim().min(1).max(255);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const ArtifactSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  type: ArtifactTypeSchema,
  schemaVersion: SchemaVersionSchema,
  mimeType: MimeTypeSchema,
  checksumSha256: Sha256Schema,
  sizeBytes: z.number().int().nonnegative(),
  storageKey: z.string().min(1),
  metadata: JsonMetadataSchema,
  createdAt: IsoDateTimeSchema,
});

export type Artifact = z.infer<typeof ArtifactSchema>;
