CREATE TABLE "execution_outputs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"execution_id" uuid NOT NULL,
	"step_execution_id" uuid NOT NULL,
	"port_name" text NOT NULL,
	"context_id" uuid NOT NULL,
	"artifact_id" uuid,
	"context" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_outputs_step_port_unique" UNIQUE("step_execution_id","port_name")
);
--> statement-breakpoint
CREATE TABLE "execution_queue" (
	"id" uuid PRIMARY KEY NOT NULL,
	"execution_id" uuid NOT NULL,
	"step_execution_id" uuid,
	"queue_type" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_queue_type_check" CHECK ("execution_queue"."queue_type" in ('execution', 'step')),
	CONSTRAINT "execution_queue_attempt_check" CHECK ("execution_queue"."attempt" >= 0)
);
--> statement-breakpoint
CREATE TABLE "execution_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"execution_id" uuid NOT NULL,
	"step_execution_id" uuid,
	"receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"execution_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"tool_version" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"input_context_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output_context_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" jsonb,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_steps_execution_node_unique" UNIQUE("execution_id","node_id"),
	CONSTRAINT "execution_steps_status_check" CHECK ("execution_steps"."status" in ('pending', 'queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled', 'timed_out')),
	CONSTRAINT "execution_steps_attempt_check" CHECK ("execution_steps"."attempt" >= 0)
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"workflow_revision_id" uuid,
	"status" text NOT NULL,
	"trace_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"budget" jsonb NOT NULL,
	"queued_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancellation_requested_at" timestamp with time zone,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "executions_owner_project_kind_idempotency_unique" UNIQUE("owner_id","project_id","kind","idempotency_key"),
	CONSTRAINT "executions_kind_check" CHECK ("executions"."kind" in ('tool', 'workflow')),
	CONSTRAINT "executions_status_check" CHECK ("executions"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out'))
);
--> statement-breakpoint
CREATE TABLE "provenance_edges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"step_execution_id" uuid,
	"source_kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provenance_edges_source_kind_check" CHECK ("provenance_edges"."source_kind" in ('context', 'artifact')),
	CONSTRAINT "provenance_edges_target_kind_check" CHECK ("provenance_edges"."target_kind" in ('context', 'artifact'))
);
--> statement-breakpoint
ALTER TABLE "execution_outputs" ADD CONSTRAINT "execution_outputs_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_outputs" ADD CONSTRAINT "execution_outputs_step_execution_id_execution_steps_id_fk" FOREIGN KEY ("step_execution_id") REFERENCES "public"."execution_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_outputs" ADD CONSTRAINT "execution_outputs_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_queue" ADD CONSTRAINT "execution_queue_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_queue" ADD CONSTRAINT "execution_queue_step_execution_id_execution_steps_id_fk" FOREIGN KEY ("step_execution_id") REFERENCES "public"."execution_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_receipts" ADD CONSTRAINT "execution_receipts_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_receipts" ADD CONSTRAINT "execution_receipts_step_execution_id_execution_steps_id_fk" FOREIGN KEY ("step_execution_id") REFERENCES "public"."execution_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_owner_id_owner_accounts_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_workflow_revision_id_document_revisions_id_fk" FOREIGN KEY ("workflow_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provenance_edges" ADD CONSTRAINT "provenance_edges_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provenance_edges" ADD CONSTRAINT "provenance_edges_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provenance_edges" ADD CONSTRAINT "provenance_edges_step_execution_id_execution_steps_id_fk" FOREIGN KEY ("step_execution_id") REFERENCES "public"."execution_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_outputs_execution_idx" ON "execution_outputs" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "execution_queue_available_idx" ON "execution_queue" USING btree ("available_at");--> statement-breakpoint
CREATE INDEX "execution_queue_lease_expiry_idx" ON "execution_queue" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE INDEX "execution_queue_execution_idx" ON "execution_queue" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "execution_receipts_execution_idx" ON "execution_receipts" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "execution_receipts_step_idx" ON "execution_receipts" USING btree ("step_execution_id");--> statement-breakpoint
CREATE INDEX "execution_steps_execution_status_idx" ON "execution_steps" USING btree ("execution_id","status");--> statement-breakpoint
CREATE INDEX "executions_project_status_idx" ON "executions" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "provenance_edges_execution_idx" ON "provenance_edges" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "provenance_edges_project_idx" ON "provenance_edges" USING btree ("project_id");