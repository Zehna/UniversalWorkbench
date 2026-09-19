import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "./common.js";

export const DecimalCursorSchema = z.string().regex(/^(0|[1-9]\d*)$/);

export const SyncEntityTypeSchema = z.enum(["project", "document", "artifact"]);

export const SyncActionSchema = z.enum([
  "project.create",
  "project.update",
  "project.delete",
  "document.create",
  "document.update",
  "document.delete",
]);

export const SyncOperationSchema = z.object({
  id: IdSchema,
  deviceId: IdSchema,
  projectId: IdSchema.nullable(),
  entityType: SyncEntityTypeSchema,
  entityId: IdSchema,
  action: SyncActionSchema,
  baseRevision: z.string().min(1).nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: IsoDateTimeSchema,
});

export const SyncChangeSchema = z.object({
  cursor: DecimalCursorSchema,
  operationId: IdSchema,
  entityType: SyncEntityTypeSchema,
  entityId: IdSchema,
  kind: z.enum(["upsert", "tombstone", "conflict"]),
  revision: z.string().min(1).nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: IsoDateTimeSchema,
});

export const ClientSyncMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("HELLO"),
    deviceId: IdSchema,
    cursor: DecimalCursorSchema,
  }),
  z.object({
    type: z.literal("SYNC_REQUEST"),
    cursor: DecimalCursorSchema,
  }),
  z.object({
    type: z.literal("PUSH_OPERATION"),
    operation: SyncOperationSchema,
  }),
  z.object({
    type: z.literal("PING"),
    nonce: z.string().min(1).max(128),
  }),
]);

export const ServerSyncMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("READY"),
    deviceId: IdSchema,
    cursor: DecimalCursorSchema,
  }),
  z.object({
    type: z.literal("ACK_OPERATION"),
    operationId: IdSchema,
    cursor: DecimalCursorSchema,
    revision: z.string().min(1).nullable(),
  }),
  z.object({
    type: z.literal("REMOTE_OPERATION"),
    change: SyncChangeSchema,
  }),
  z.object({
    type: z.literal("CONFLICT"),
    operationId: IdSchema,
    change: SyncChangeSchema,
  }),
  z.object({
    type: z.literal("PONG"),
    nonce: z.string().min(1).max(128),
  }),
  z.object({
    type: z.literal("ERROR"),
    code: z.string().min(1),
    message: z.string().min(1),
  }),
]);

export type DecimalCursor = z.infer<typeof DecimalCursorSchema>;
export type SyncEntityType = z.infer<typeof SyncEntityTypeSchema>;
export type SyncAction = z.infer<typeof SyncActionSchema>;
export type SyncOperation = z.infer<typeof SyncOperationSchema>;
export type SyncChange = z.infer<typeof SyncChangeSchema>;
export type ClientSyncMessage = z.infer<typeof ClientSyncMessageSchema>;
export type ServerSyncMessage = z.infer<typeof ServerSyncMessageSchema>;
