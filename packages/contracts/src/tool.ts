import { z } from "zod";
import {
  ContextTypeSchema,
  JsonObjectSchema,
} from "./context.js";

export const ToolExecutionModeSchema = z.enum([
  "local",
  "server",
  "worker",
  "hybrid",
]);

export const ToolCapabilitySchema = z.enum([
  "network.public",
  "project.documents.read",
  "project.documents.write",
  "project.artifacts.read",
  "project.artifacts.write",
]);

export const ToolIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);

export const ToolVersionSchema = z.string().trim().min(1).max(64);
export const ToolPortNameSchema = z.string().trim().min(1).max(64);

export const ToolReferenceSchema = z.object({
  id: ToolIdSchema,
  version: ToolVersionSchema,
});

export const ToolInputPortSchema = z.object({
  name: ToolPortNameSchema,
  types: z.array(ContextTypeSchema).min(1),
  required: z.boolean().default(true),
});

export const ToolOutputPortSchema = z.object({
  name: ToolPortNameSchema,
  types: z.array(ContextTypeSchema).min(1),
});

export const ToolDefaultsSchema = z.object({
  timeoutMs: z.number().int().positive(),
  maxAttempts: z.number().int().min(1).max(3),
});

export const ToolDefinitionSchema = z.object({
  id: ToolIdSchema,
  version: ToolVersionSchema,
  displayName: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2000),
  executionMode: ToolExecutionModeSchema,
  accepts: z.array(ToolInputPortSchema),
  produces: z.array(ToolOutputPortSchema),
  configSchema: JsonObjectSchema,
  requiredCapabilities: z.array(ToolCapabilitySchema),
  defaults: ToolDefaultsSchema,
});

export type ToolExecutionMode = z.infer<typeof ToolExecutionModeSchema>;
export type ToolCapability = z.infer<typeof ToolCapabilitySchema>;
export type ToolReference = z.infer<typeof ToolReferenceSchema>;
export type ToolInputPort = z.infer<typeof ToolInputPortSchema>;
export type ToolOutputPort = z.infer<typeof ToolOutputPortSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
