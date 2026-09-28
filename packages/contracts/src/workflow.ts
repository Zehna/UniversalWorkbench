import { z } from "zod";
import { IdSchema } from "./common.js";

export const WorkflowInputBindingSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("workflow_input") }),
  z.object({
    source: z.literal("node_output"),
    nodeId: IdSchema,
    outputIndex: z.number().int().nonnegative(),
  }),
]);

export const WorkflowNodeSchema = z.object({
  id: IdSchema,
  toolId: z.string().trim().min(1).max(128),
  toolVersion: z.string().trim().min(1).max(64),
  config: z.unknown(),
  input: WorkflowInputBindingSchema,
  timeoutMs: z.number().int().positive().optional(),
  retry: z
    .object({
      maxAttempts: z.number().int().positive(),
      backoffMs: z.number().int().nonnegative(),
    })
    .optional(),
  idempotencyKey: z.string().trim().min(1).max(256).optional(),
});

export const WorkflowEdgeSchema = z.object({
  from: IdSchema,
  to: IdSchema,
});

export const WorkflowDefinitionSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    name: z.string().trim().min(1).max(200),
    schemaVersion: z.literal(1),
    nodes: z.array(WorkflowNodeSchema),
    edges: z.array(WorkflowEdgeSchema),
  })
  .superRefine((workflow, ctx) => {
    const seen = new Set<string>();
    workflow.nodes.forEach((node, index) => {
      if (seen.has(node.id)) {
        ctx.addIssue({
          code: "custom",
          message: "Workflow node IDs must be unique",
          path: ["nodes", index, "id"],
        });
      }
      seen.add(node.id);
    });
  });

export type WorkflowInputBinding = z.infer<typeof WorkflowInputBindingSchema>;
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
