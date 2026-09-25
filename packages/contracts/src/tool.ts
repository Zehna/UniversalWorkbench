import { z } from "zod";
import { ContextTypeSchema } from "./context.js";

const ExactToolVersionSchema = z
  .string()
  .trim()
  .regex(
    /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$/,
    "Tool version must be an exact semantic version",
  );

export const ToolExecutionModeSchema = z.enum([
  "local",
  "server",
  "worker",
  "hybrid",
]);

export const ToolIdempotencySchema = z.enum(["safe", "keyed", "unsafe"]);

export const ToolDescriptorSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  version: ExactToolVersionSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2000),
  accepts: z.array(ContextTypeSchema).min(1),
  produces: z.array(ContextTypeSchema).min(1),
  permissions: z.array(z.string().trim().min(1).max(128)),
  capabilities: z.array(z.string().trim().min(1).max(128)),
  executionMode: ToolExecutionModeSchema,
  idempotency: ToolIdempotencySchema,
  configSchema: z.record(z.string(), z.unknown()),
});

export type ToolExecutionMode = z.infer<typeof ToolExecutionModeSchema>;
export type ToolIdempotency = z.infer<typeof ToolIdempotencySchema>;
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;
