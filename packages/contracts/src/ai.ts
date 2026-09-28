import { z } from "zod";
import { SecretRefSchema } from "./secrets.js";

export const AiUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

export const AiUsageSourceSchema = z.enum(["provider", "estimated"]);

export const AiResponsePayloadSchema = z.object({
  text: z.string(),
  model: z.string().trim().min(1).max(256),
  structured: z.unknown().optional(),
  usage: AiUsageSchema,
  usageSource: AiUsageSourceSchema,
  providerRequestId: z.string().trim().min(1).max(256).optional(),
});

export const AiResponseFormatSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text") }),
  z.object({
    kind: z.literal("json"),
    jsonSchema: z.record(z.string(), z.unknown()),
  }),
]);

export const AiToolConfigSchema = z.object({
  providerId: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(256),
  prompt: z.string().trim().min(1).max(100_000),
  systemPrompt: z.string().trim().min(1).max(100_000).optional(),
  secretRef: SecretRefSchema,
  responseFormat: AiResponseFormatSchema.optional(),
  maxOutputTokens: z.number().int().min(1).max(128_000).optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});

export const ExecutionUsageV2Schema = z.object({
  attempts: z.number().int().nonnegative(),
  inputBytes: z.number().int().nonnegative(),
  outputBytes: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

export const LegacyExecutionUsageSchema = z.object({
  attempts: z.number().int().nonnegative(),
  inputBytes: z.number().int().nonnegative(),
  outputBytes: z.number().int().nonnegative(),
});

export type AiUsage = z.infer<typeof AiUsageSchema>;
export type AiUsageSource = z.infer<typeof AiUsageSourceSchema>;
export type AiResponsePayload = z.infer<typeof AiResponsePayloadSchema>;
export type AiResponseFormat = z.infer<typeof AiResponseFormatSchema>;
export type AiToolConfig = z.infer<typeof AiToolConfigSchema>;
export type ExecutionUsageV2 = z.infer<typeof ExecutionUsageV2Schema>;
export type LegacyExecutionUsage = z.infer<typeof LegacyExecutionUsageSchema>;

export function migrateLegacyUsage(
  usage: LegacyExecutionUsage,
): ExecutionUsageV2 {
  const parsed = LegacyExecutionUsageSchema.parse(usage);
  return {
    ...parsed,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}
