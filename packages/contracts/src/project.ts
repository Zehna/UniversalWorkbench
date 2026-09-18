import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, SchemaVersionSchema } from "./common.js";

export const ProjectNameSchema = z.string().trim().min(1).max(120);
export const ProjectDescriptionSchema = z.string().max(2000).nullable();

export const ProjectSchema = z.object({
  id: IdSchema,
  ownerId: IdSchema,
  name: ProjectNameSchema,
  description: ProjectDescriptionSchema,
  schemaVersion: SchemaVersionSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const CreateProjectRequestSchema = z.object({
  name: ProjectNameSchema,
  description: ProjectDescriptionSchema.optional(),
});

export const UpdateProjectRequestSchema = z
  .object({
    name: ProjectNameSchema.optional(),
    description: ProjectDescriptionSchema.optional(),
  })
  .refine(
    (value) => value.name !== undefined || value.description !== undefined,
    "At least one project field must be provided",
  );

export type Project = z.infer<typeof ProjectSchema>;
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;
