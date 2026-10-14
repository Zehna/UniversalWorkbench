import { z } from "zod";
import { ContextEnvelopeSchema } from "./context.js";

export const CodeLanguageSchema = z.enum(["javascript", "typescript"]);
export type CodeLanguage = z.infer<typeof CodeLanguageSchema>;

export const CodeInterpreterConfigSchema = z.object({
  language: CodeLanguageSchema.default("javascript"),
  code: z.string().trim().min(1).max(50_000),
  timeoutMs: z.number().int().min(100).max(10_000).default(3_000),
  memoryLimitMb: z.number().int().min(16).max(256).default(64).optional(),
});
export type CodeInterpreterConfig = z.infer<
  typeof CodeInterpreterConfigSchema
>;

export const CodeExecutionResultSchema = z.object({
  success: z.boolean(),
  result: z.unknown().optional(),
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  durationMs: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type CodeExecutionResult = z.infer<
  typeof CodeExecutionResultSchema
>;

export const CodeResultEnvelopeSchema = ContextEnvelopeSchema.extend({
  type: z.literal("code_result"),
  payload: CodeExecutionResultSchema,
});
export type CodeResultEnvelope = z.infer<
  typeof CodeResultEnvelopeSchema
>;
