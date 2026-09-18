CREATE TABLE "sync_changes" (
	"cursor" bigserial PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"revision" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sync_changes_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "sync_changes_kind_check" CHECK ("sync_changes"."kind" in ('upsert', 'tombstone', 'conflict'))
);
--> statement-breakpoint
CREATE TABLE "sync_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sync_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"project_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"base_revision" text,
	"payload" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"result_revision" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sync_operations_outcome_check" CHECK ("sync_operations"."outcome" in ('applied', 'conflict'))
);
--> statement-breakpoint
CREATE TABLE "sync_tombstones" (
	"owner_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"project_id" uuid,
	"operation_id" uuid NOT NULL,
	"cursor" bigint NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sync_tombstones_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "sync_tombstones_owner_entity_unique" UNIQUE("owner_id","entity_type","entity_id")
);
--> statement-breakpoint
ALTER TABLE "sync_changes" ADD CONSTRAINT "sync_changes_owner_id_owner_accounts_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_changes" ADD CONSTRAINT "sync_changes_operation_id_sync_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."sync_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_devices" ADD CONSTRAINT "sync_devices_owner_id_owner_accounts_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_owner_id_owner_accounts_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_device_id_sync_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."sync_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_tombstones" ADD CONSTRAINT "sync_tombstones_owner_id_owner_accounts_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_tombstones" ADD CONSTRAINT "sync_tombstones_operation_id_sync_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."sync_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_tombstones" ADD CONSTRAINT "sync_tombstones_cursor_sync_changes_cursor_fk" FOREIGN KEY ("cursor") REFERENCES "public"."sync_changes"("cursor") ON DELETE no action ON UPDATE no action;