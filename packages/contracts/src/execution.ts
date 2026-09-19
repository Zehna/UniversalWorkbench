import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "./common.js";
import { JsonValueSchema } from "./context.js";
import {
  ToolCapabilitySchema,
  ToolReferenceSchema,
} from "./tool.js";

export const ExecutionKindSchema = z.enum(["tool", "workflow"]);

export const ExecutionStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

export const StepExecutionStatusSchema = z.enum([
  "pending",
  "queued",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
  "timed_out",
]);

export const ExecutionErrorCodeSchema = z.enum([
  "VALIDATION",
  "PERMISSION_DENIED",
  "UNSAFE_EGRESS",
  "NETWORK_TRANSIENT",
  "UPSTREAM_RATE_LIMIT",
  "UPSTREAM_4XX",
  "UPSTREAM_5XX",
  "TIMEOUT",
  "CANCELLED",
  "OUTPUT_TOO_LARGE",
  "BUDGET_EXCEEDED",
  "TOOL_BUG",
]);

export const ExecutionBudgetSchema = z.object({
  maxWallClockMs: z.number().int().positive(),
  maxSteps: z.number().int().positive(),
  maxAttemptsPerStep: z.number().int().min(1).max(3),
  maxTotalAttempts: z.number().int().positive(),
  maxOutputBytes: z.number().int().positive(),
  maxHttpRequests: z.number().int().nonnegative(),
});

export const SanitizedExecutionErrorSchema = z.object({
  code: ExecutionErrorCodeSchema,
  message: z.string().min(1).max(2000),
  details: JsonValueSchema.optional(),
});

export const ExecutionUsageSchema = z.object({
  outputBytes: z.number().int().nonnegative(),
  httpRequests: z.number().int().nonnegative(),
});

export const ExecutionSchema = z.object({
  id: IdSchema,
  ownerId: IdSchema,
  projectId: IdSchema,
  kind: ExecutionKindSchema,
  workflowRevisionId: IdSchema.optional(),
  status: ExecutionStatusSchema,
  traceId: z.string().min(1).max(256),
  idempotencyKey: z.string().min(1).max(256),
  budget: ExecutionBudgetSchema,
  queuedAt: IsoDateTimeSchema,
  startedAt: IsoDateTimeSchema.optional(),
  finishedAt: IsoDateTimeSchema.optional(),
  cancellationRequestedAt: IsoDateTimeSchema.optional(),
  error: SanitizedExecutionErrorSchema.optional(),
});

export const ExecutionReceiptSchema = z.object({
  id: IdSchema,
  executionId: IdSchema,
  stepExecutionId: IdSchema.nullable(),
  workflowRevisionId: IdSchema.nullable(),
  tool: ToolReferenceSchema.nullable(),
  inputContextIds: z.array(IdSchema),
  outputContextIds: z.array(IdSchema),
  capabilities: z.array(ToolCapabilitySchema),
  attemptCount: z.number().int().positive(),
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema,
  status: z.enum(["succeeded", "failed", "cancelled", "timed_out"]),
  error: SanitizedExecutionErrorSchema.nullable(),
  usage: ExecutionUsageSchema,
  provenanceEdgeIds: z.array(IdSchema),
});

export type ExecutionKind = z.infer<typeof ExecutionKindSchema>;
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;
export type StepExecutionStatus = z.infer<typeof StepExecutionStatusSchema>;
export type ExecutionErrorCode = z.infer<typeof ExecutionErrorCodeSchema>;
export type ExecutionBudget = z.infer<typeof ExecutionBudgetSchema>;
export type SanitizedExecutionError = z.infer<
  typeof SanitizedExecutionErrorSchema
>;
export type ExecutionUsage = z.infer<typeof ExecutionUsageSchema>;
export type Execution = z.infer<typeof ExecutionSchema>;
export type ExecutionReceipt = z.infer<typeof ExecutionReceiptSchema>;
