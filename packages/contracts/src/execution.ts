import { z } from "zod";

export const ExecutionStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;
