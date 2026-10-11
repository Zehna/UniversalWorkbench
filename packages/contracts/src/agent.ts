import { z } from "zod";
import { IsoDateTimeSchema } from "./common.js";
import { ContextEnvelopeSchema } from "./context.js";
import { AiUsageSchema, AiUsageSourceSchema } from "./ai.js";
import { SecretRefSchema } from "./secrets.js";

export const AiAgentConfigSchema = z.object({
  providerId: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(256),
  prompt: z.string().trim().min(1).max(100_000),
  systemPrompt: z.string().trim().min(1).max(100_000).optional(),
  secretRef: SecretRefSchema,
  allowedTools: z.array(z.string().trim().min(1).max(128)).default([]),
  maxIterations: z.number().int().min(1).max(15).default(5),
  maxOutputTokens: z.number().int().min(1).max(128_000).optional(),
});
export type AiAgentConfig = z.infer<typeof AiAgentConfigSchema>;

export const AgentToolCallSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  tool: z.string().trim().min(1).optional(),
  arguments: z.record(z.string(), z.unknown()).default({}),
});
export type AgentToolCall = z.infer<typeof AgentToolCallSchema>;

export const AgentObservationSchema = z.object({
  toolCallId: z.string().trim().min(1).optional(),
  output: z.unknown(),
  durationMs: z.number().int().nonnegative().optional(),
  isError: z.boolean().default(false).optional(),
});
export type AgentObservation = z.infer<typeof AgentObservationSchema>;

export const AgentTraceItemSchema = z.object({
  iteration: z.number().int().positive(),
  type: z
    .enum(["step", "thought", "tool_call", "observation", "final_answer"])
    .optional(),
  thought: z.string().optional(),
  toolCall: AgentToolCallSchema.optional(),
  observation: AgentObservationSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  timestamp: IsoDateTimeSchema.optional(),
});
export type AgentTraceItem = z.infer<typeof AgentTraceItemSchema>;

export const AgentStatusSchema = z.enum([
  "completed",
  "iteration_limit_reached",
  "awaiting_approval",
  "error",
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentApprovalRequestSchema = z.object({
  executionId: z.string().trim().min(1),
  nodeId: z.string().trim().min(1),
  toolCall: AgentToolCallSchema,
  reason: z.string().trim().min(1).max(2000).optional(),
});
export type AgentApprovalRequest = z.infer<typeof AgentApprovalRequestSchema>;

export const AgentApprovalDecisionSchema = z.enum(["approved", "rejected"]);
export type AgentApprovalDecision = z.infer<typeof AgentApprovalDecisionSchema>;

export const AgentApprovalResolutionSchema = z.object({
  decision: AgentApprovalDecisionSchema,
  rejectionReason: z.string().trim().min(1).max(2000).optional(),
});
export type AgentApprovalResolution = z.infer<
  typeof AgentApprovalResolutionSchema
>;

export const AgentResponsePayloadSchema = z.object({
  text: z.string(),
  model: z.string().trim().min(1).max(256),
  status: AgentStatusSchema.default("completed"),
  iterations: z.number().int().nonnegative(),
  trace: z.array(AgentTraceItemSchema).default([]),
  usage: AiUsageSchema,
  usageSource: AiUsageSourceSchema,
  structured: z.unknown().optional(),
});
export type AgentResponsePayload = z.infer<typeof AgentResponsePayloadSchema>;

export const AgentResponseEnvelopeSchema = ContextEnvelopeSchema.extend({
  type: z.literal("agent_response"),
  payload: AgentResponsePayloadSchema,
});
export type AgentResponseEnvelope = z.infer<typeof AgentResponseEnvelopeSchema>;
