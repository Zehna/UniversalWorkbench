import { z } from "zod";

export const HealthStatusSchema = z.object({
  status: z.literal("ok"),
});

export const ReadinessStatusSchema = z.object({
  status: z.enum(["ready", "not_ready"]),
  checks: z.object({
    database: z.enum(["ok", "error"]),
  }),
});

export type HealthStatus = z.infer<typeof HealthStatusSchema>;
export type ReadinessStatus = z.infer<typeof ReadinessStatusSchema>;
