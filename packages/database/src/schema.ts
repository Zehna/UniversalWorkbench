import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
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
    .default(0n),
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
