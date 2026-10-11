import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
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

export const workflowDefinitions = pgTable(
  "workflow_definitions",
  {
    id: uuid("id").primaryKey(),
    workflowId: uuid("workflow_id").notNull(),
    version: integer("version").notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => ownerAccounts.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    name: text("name").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("workflow_definitions_workflow_version_unique").on(
      table.workflowId,
      table.version,
    ),
    check("workflow_definitions_version_check", sql`${table.version} > 0`),
    check(
      "workflow_definitions_schema_version_check",
      sql`${table.schemaVersion} > 0`,
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
    workflowDefinitionId: uuid("workflow_definition_id")
      .notNull()
      .references(() => workflowDefinitions.id),
    status: text("status").notNull(),
    traceId: uuid("trace_id").notNull(),
    inputContext: jsonb("input_context")
      .$type<Record<string, unknown>>()
      .notNull(),
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
  },
  (table) => [
    check(
      "executions_status_check",
      sql`${table.status} in ('queued','running','completed','failed','cancelled','interrupted')`,
    ),
    check(
      "executions_timing_check",
      sql`(
        (${table.status} = 'queued' and ${table.startedAt} is null and ${table.finishedAt} is null)
        or (${table.status} = 'running' and ${table.startedAt} is not null and ${table.finishedAt} is null)
        or (${table.status} in ('completed','failed','cancelled','interrupted') and ${table.finishedAt} is not null)
      )`,
    ),
    check(
      "executions_error_check",
      sql`${table.error} is null or ${table.status} in ('failed','interrupted')`,
    ),
  ],
);

export const executionSteps = pgTable(
  "execution_steps",
  {
    id: uuid("id").primaryKey(),
    executionId: uuid("execution_id")
      .notNull()
      .references(() => executions.id),
    nodeId: uuid("node_id").notNull(),
    toolId: text("tool_id").notNull(),
    toolVersion: text("tool_version").notNull(),
    attempt: integer("attempt").notNull(),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    inputContext: jsonb("input_context")
      .$type<Record<string, unknown>>()
      .notNull(),
    outputContexts: jsonb("output_contexts")
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    error: jsonb("error").$type<Record<string, unknown>>(),
    idempotencyKey: text("idempotency_key"),
  },
  (table) => [
    unique("execution_steps_execution_node_attempt_unique").on(
      table.executionId,
      table.nodeId,
      table.attempt,
    ),
    check("execution_steps_attempt_check", sql`${table.attempt} > 0`),
    check(
      "execution_steps_status_check",
      sql`${table.status} in ('queued','running','completed','failed','cancelled','interrupted')`,
    ),
    check(
      "execution_steps_timing_check",
      sql`(
        (${table.status} = 'queued' and ${table.startedAt} is null and ${table.finishedAt} is null)
        or (${table.status} = 'running' and ${table.startedAt} is not null and ${table.finishedAt} is null)
        or (${table.status} in ('completed','failed','cancelled','interrupted') and ${table.finishedAt} is not null)
      )`,
    ),
  ],
);

export const provenanceEdges = pgTable(
  "provenance_edges",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    executionId: uuid("execution_id")
      .notNull()
      .references(() => executions.id),
    fromContextId: uuid("from_context_id").notNull(),
    toContextId: uuid("to_context_id").notNull(),
    nodeId: uuid("node_id").notNull(),
  },
  (table) => [
    unique("provenance_edges_execution_context_node_unique").on(
      table.executionId,
      table.fromContextId,
      table.toContextId,
      table.nodeId,
    ),
  ],
);

export const executionReceipts = pgTable("execution_receipts", {
  executionId: uuid("execution_id")
    .primaryKey()
    .references(() => executions.id),
  receipt: jsonb("receipt").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const executionQueue = pgTable(
  "execution_queue",
  {
    executionId: uuid("execution_id")
      .primaryKey()
      .references(() => executions.id),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseToken: uuid("lease_token"),
    leasedUntil: timestamp("leased_until", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
  },
  (table) => [
    index("execution_queue_ready_idx").on(
      table.availableAt,
      table.enqueuedAt,
      table.executionId,
    ),
    index("execution_queue_lease_expiry_idx").on(table.leasedUntil),
    check("execution_queue_attempts_check", sql`${table.attempts} >= 0`),
    check(
      "execution_queue_lease_consistency_check",
      sql`(
        (${table.leaseOwner} is null and ${table.leaseToken} is null and ${table.leasedUntil} is null)
        or
        (${table.leaseOwner} is not null and ${table.leaseToken} is not null and ${table.leasedUntil} is not null)
      )`,
    ),
  ],
);

export const executionRequests = pgTable(
  "execution_requests",
  {
    executionId: uuid("execution_id")
      .primaryKey()
      .references(() => executions.id),
    grantedPermissions: jsonb("granted_permissions")
      .$type<string[]>()
      .notNull(),
    budget: jsonb("budget").$type<Record<string, number>>().notNull(),
  },
  (table) => [
    check(
      "execution_requests_permissions_check",
      sql`jsonb_typeof(${table.grantedPermissions}) = 'array'`,
    ),
    check(
      "execution_requests_budget_check",
      sql`jsonb_typeof(${table.budget}) = 'object'`,
    ),
  ],
);

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    transportConfig: jsonb("transport_config")
      .$type<Record<string, unknown>>()
      .notNull(),
    secretRefs: jsonb("secret_refs").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("mcp_servers_owner_project_idx").on(table.ownerId, table.projectId),
  ],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const vaultSecrets = pgTable(
  "vault_secrets",
  {
    ownerId: uuid("owner_id").notNull(),
    name: text("name").notNull(),
    keyVersion: integer("key_version").notNull(),
    iv: bytea("iv").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    authTag: bytea("auth_tag").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("vault_secrets_owner_name_unique").on(table.ownerId, table.name),
    index("vault_secrets_owner_idx").on(table.ownerId),
    index("vault_secrets_version_idx").on(table.keyVersion),
    check("vault_secrets_key_version_check", sql`${table.keyVersion} > 0`),
    check("vault_secrets_iv_check", sql`octet_length(${table.iv}) = 12`),
    check(
      "vault_secrets_ciphertext_check",
      sql`octet_length(${table.ciphertext}) > 0`,
    ),
    check(
      "vault_secrets_auth_tag_check",
      sql`octet_length(${table.authTag}) = 16`,
    ),
  ],
);
