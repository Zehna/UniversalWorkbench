import { z } from "zod";

export const IdSchema = z.string().uuid();
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const SchemaVersionSchema = z.number().int().positive();
export const JsonMetadataSchema = z.record(z.string(), z.unknown()).default({});

export type Id = z.infer<typeof IdSchema>;
export type JsonMetadata = z.infer<typeof JsonMetadataSchema>;
