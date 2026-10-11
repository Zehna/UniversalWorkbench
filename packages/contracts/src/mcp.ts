import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "./common.js";
import { SecretRefSchema } from "./secrets.js";

export const McpTransportTypeSchema = z.enum(["stdio", "sse"]);
export type McpTransportType = z.infer<typeof McpTransportTypeSchema>;

export const McpStdioConfigSchema = z.object({
  transport: z.literal("stdio"),
  command: z.string().trim().min(1).max(1024),
  args: z.array(z.string().trim().min(1).max(1024)).default([]),
  env: z.record(z.string().trim().min(1), z.string()).default({}),
});
export type McpStdioConfig = z.infer<typeof McpStdioConfigSchema>;

export const McpSseConfigSchema = z.object({
  transport: z.literal("sse"),
  url: z.string().trim().min(1).url(),
  headers: z.record(z.string().trim().min(1), z.string()).default({}),
});
export type McpSseConfig = z.infer<typeof McpSseConfigSchema>;

export const McpServerTransportConfigSchema = z.discriminatedUnion(
  "transport",
  [McpStdioConfigSchema, McpSseConfigSchema],
);
export type McpServerTransportConfig = z.infer<
  typeof McpServerTransportConfigSchema
>;

export const McpServerConfigSchema = z.object({
  id: IdSchema,
  projectId: IdSchema.optional(),
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  transportConfig: McpServerTransportConfigSchema,
  secretRefs: z.array(SecretRefSchema).default([]),
  createdAt: IsoDateTimeSchema.optional(),
  updatedAt: IsoDateTimeSchema.optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpToolMetadataSchema = z.object({
  serverId: z.string().trim().min(1),
  serverName: z.string().trim().min(1).max(120),
  toolName: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(2000).optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  requiresApproval: z.boolean().default(false),
});
export type McpToolMetadata = z.infer<typeof McpToolMetadataSchema>;

export const CreateMcpServerRequestSchema = z.object({
  projectId: IdSchema.optional(),
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true).optional(),
  transportConfig: McpServerTransportConfigSchema,
  secretRefs: z.array(SecretRefSchema).default([]).optional(),
});
export type CreateMcpServerRequest = z.infer<
  typeof CreateMcpServerRequestSchema
>;

export const UpdateMcpServerRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
    transportConfig: McpServerTransportConfigSchema.optional(),
    secretRefs: z.array(SecretRefSchema).optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.enabled !== undefined ||
      value.transportConfig !== undefined ||
      value.secretRefs !== undefined,
    "At least one mcp server field must be provided",
  );
export type UpdateMcpServerRequest = z.infer<
  typeof UpdateMcpServerRequestSchema
>;
