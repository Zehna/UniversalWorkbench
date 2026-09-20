import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const ownerAccounts = pgTable(
  "owner_accounts",
  {
    id: uuid("id").primaryKey(),
    singletonKey: smallint("singleton_key").notNull().default(1).unique(),
    username: text("username").notNull().unique(),
    passwordAlgorithm: text("password_algorithm").notNull(),
    passwordSalt: text("password_salt").notNull(),
    passwordHash: text("password_hash").notNull(),
    passwordParameters: jsonb("password_parameters")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("owner_accounts_singleton_key_check", sql`${table.singletonKey} = 1`),
  ],
);

export const authSessions = pgTable("auth_sessions", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => ownerAccounts.id),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => ownerAccounts.id),
  name: text("name").notNull(),
  description: text("description"),
  schemaVersion: integer("schema_version").notNull().default(1),
  syncRevision: bigint("sync_revision", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  currentRevisionId: uuid("current_revision_id").references(
    (): AnyPgColumn => documentRevisions.id,
  ),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const documentRevisions = pgTable(
  "document_revisions",
  {
    id: uuid("id").primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    revisionNumber: integer("revision_number").notNull(),
    parentRevisionId: uuid("parent_revision_id").references(
      (): AnyPgColumn => documentRevisions.id,
    ),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("document_revisions_document_revision_unique").on(
      table.documentId,
      table.revisionNumber,
    ),
  ],
);

export const artifacts = pgTable("artifacts", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  type: text("type").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  mimeType: text("mime_type").notNull(),
  checksumSha256: text("checksum_sha256").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  storageKey: text("storage_key").notNull().unique(),
  metadata: jsonb("metadata")
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const actionAudit = pgTable("action_audit", {
  id: uuid("id").primaryKey(),
  actorId: uuid("actor_id")
    .notNull()
    .references(() => ownerAccounts.id),
  projectId: uuid("project_id").references(() => projects.id),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id"),
  traceId: uuid("trace_id").notNull(),
  metadata: jsonb("metadata")
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const syncDevices = pgTable("sync_devices", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => ownerAccounts.id),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const syncOperations = pgTable(
  "sync_operations",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => ownerAccounts.id),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => syncDevices.id),
    projectId: uuid("project_id"),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    action: text("action").notNull(),
    baseRevision: text("base_revision"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    outcome: text("outcome").notNull(),
    resultRevision: text("result_revision"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "sync_operations_outcome_check",
      sql`${table.outcome} in ('applied', 'conflict')`,
    ),
  ],
);

export const syncChanges = pgTable(
  "sync_changes",
  {
    cursor: bigserial("cursor", { mode: "bigint" }).primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => ownerAccounts.id),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => syncOperations.id)
      .unique(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    kind: text("kind").notNull(),
    revision: text("revision"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "sync_changes_kind_check",
      sql`${table.kind} in ('upsert', 'tombstone', 'conflict')`,
    ),
  ],
);

export const syncTombstones = pgTable(
  "sync_tombstones",
  {
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => ownerAccounts.id),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    projectId: uuid("project_id"),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => syncOperations.id)
      .unique(),
    cursor: bigint("cursor", { mode: "bigint" })
      .notNull()
      .references(() => syncChanges.cursor),
    deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("sync_tombstones_owner_entity_unique").on(
      table.ownerId,
      table.entityType,
      table.entityId,
    ),
  ],
);

export const executions = pgTable(
  "executions",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => ownerAccounts.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    kind: text("kind").notNull(),
    workflowRevisionId: uuid("workflow_revision_id").references(
      () => documentRevisions.id,
    ),
    status: text("status").notNull(),
    traceId: uuid("trace_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    budget: jsonb("budget").$type<Record<string, unknown>>().notNull(),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    cancellationRequestedAt: timestamp("cancellation_requested_at", {
      withTimezone: true,
    }),
    error: jsonb("error").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("executions_kind_check", sql`${table.kind} in ('tool', 'workflow')`),
    check(
      "executions_status_check",
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out')`,
    ),
    unique("executions_owner_project_kind_idempotency_unique").on(
      table.ownerId,
      table.projectId,
      table.kind,
      table.idempotencyKey,
    ),
    index("executions_project_status_idx").on(table.projectId, table.status),
  ],
);

export const executionSteps = pgTable(
  "execution_steps",
  {
    id: uuid("id").primaryKey(),
    executionId: uuid("execution_id")
      .notNull()
      .references(() => executions.id),
    nodeId: text("node_id").notNull(),
    toolId: text("tool_id").notNull(),
    toolVersion: text("tool_version").notNull(),
    config: jsonb("config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status").notNull(),
    attempt: integer("attempt").notNull().default(0),
    inputContextIds: jsonb("input_context_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    outputContextIds: jsonb("output_context_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: jsonb("error").$type<Record<string, unknown>>(),
    usage: jsonb("usage")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "execution_steps_status_check",
      sql`${table.status} in ('pending', 'queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled', 'timed_out')`,
    ),
    check("execution_steps_attempt_check", sql`${table.attempt} >= 0`),
    unique("execution_steps_execution_node_unique").on(
      table.executionId,
      table.nodeId,
    ),
    index("execution_steps_execution_status_idx").on(
      table.executionId,
      table.status,
    ),
  ],
);

export const executionOutputs = pgTable(
  "execution_outputs",
  {
    id: uuid("id").primaryKey(),
    executionId: uuid("execution_id")
      .notNull()
      .references(() => executions.id),
    stepExecutionId: uuid("step_execution_id")
      .notNull()
      .references(() => executionSteps.id),
    portName: text("port_name").notNull(),
    contextId: uuid("context_id").notNull(),
    artifactId: uuid("artifact_id").references(() => artifacts.id),
    context: jsonb("context").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("execution_outputs_step_port_unique").on(
      table.stepExecutionId,
      table.portName,
    ),
    index("execution_outputs_execution_idx").on(table.executionId),
  ],
);

export const executionReceipts = pgTable(
  "execution_receipts",
  {
    id: uuid("id").primaryKey(),
    executionId: uuid("execution_id")
      .notNull()
      .references(() => executions.id),
    stepExecutionId: uuid("step_execution_id").references(
      () => executionSteps.id,
    ),
    receipt: jsonb("receipt").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("execution_receipts_execution_idx").on(table.executionId),
    index("execution_receipts_step_idx").on(table.stepExecutionId),
  ],
);

export const executionQueue = pgTable(
  "execution_queue",
  {
    id: uuid("id").primaryKey(),
    executionId: uuid("execution_id")
      .notNull()
      .references(() => executions.id),
    stepExecutionId: uuid("step_execution_id").references(
      () => executionSteps.id,
    ),
    queueType: text("queue_type").notNull(),
    attempt: integer("attempt").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "execution_queue_type_check",
      sql`${table.queueType} in ('execution', 'step')`,
    ),
    check("execution_queue_attempt_check", sql`${table.attempt} >= 0`),
    index("execution_queue_available_idx").on(table.availableAt),
    index("execution_queue_lease_expiry_idx").on(table.leaseExpiresAt),
    index("execution_queue_execution_idx").on(table.executionId),
  ],
);

export const provenanceEdges = pgTable(
  "provenance_edges",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    executionId: uuid("execution_id")
      .notNull()
      .references(() => executions.id),
    stepExecutionId: uuid("step_execution_id").references(
      () => executionSteps.id,
    ),
    sourceKind: text("source_kind").notNull(),
    sourceId: uuid("source_id").notNull(),
    targetKind: text("target_kind").notNull(),
    targetId: uuid("target_id").notNull(),
    relation: text("relation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "provenance_edges_source_kind_check",
      sql`${table.sourceKind} in ('context', 'artifact')`,
    ),
    check(
      "provenance_edges_target_kind_check",
      sql`${table.targetKind} in ('context', 'artifact')`,
    ),
    index("provenance_edges_execution_idx").on(table.executionId),
    index("provenance_edges_project_idx").on(table.projectId),
  ],
);
