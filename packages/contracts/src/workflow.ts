import { z } from "zod";
import { JsonObjectSchema } from "./context.js";
import { ToolPortNameSchema, ToolReferenceSchema } from "./tool.js";

export const WorkflowNodeIdSchema = z.string().trim().min(1).max(128);

export const WorkflowNodeSchema = z.object({
  id: WorkflowNodeIdSchema,
  tool: ToolReferenceSchema,
  config: JsonObjectSchema,
});

export const WorkflowEdgeSchema = z.object({
  from: z.object({
    nodeId: WorkflowNodeIdSchema,
    output: ToolPortNameSchema,
  }),
  to: z.object({
    nodeId: WorkflowNodeIdSchema,
    input: ToolPortNameSchema,
  }),
});

export const WorkflowOutputBindingSchema = z.object({
  name: z.string().trim().min(1).max(128),
  from: z.object({
    nodeId: WorkflowNodeIdSchema,
    output: ToolPortNameSchema,
  }),
});

export const WorkflowDefinitionV1Schema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  nodes: z.array(WorkflowNodeSchema),
  edges: z.array(WorkflowEdgeSchema),
  outputs: z.array(WorkflowOutputBindingSchema),
});

export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;
export type WorkflowOutputBinding = z.infer<typeof WorkflowOutputBindingSchema>;
export type WorkflowDefinitionV1 = z.infer<typeof WorkflowDefinitionV1Schema>;
