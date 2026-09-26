CREATE TABLE "workflow_definitions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workflow_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "owner_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "name" text NOT NULL,
  "schema_version" integer NOT NULL,
  "definition" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_definitions_workflow_version_unique" UNIQUE("workflow_id","version"),
  CONSTRAINT "workflow_definitions_version_check" CHECK ("version" > 0),
  CONSTRAINT "workflow_definitions_schema_version_check" CHECK ("schema_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "executions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "owner_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "workflow_definition_id" uuid NOT NULL,
  "status" text NOT NULL,
  "trace_id" uuid NOT NULL,
  "input_context" jsonb NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "error" jsonb,
  "usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "executions_status_check" CHECK ("status" in ('queued','running','completed','failed','cancelled','interrupted')),
  CONSTRAINT "executions_timing_check" CHECK (
    ("status" = 'queued' and "started_at" is null and "finished_at" is null)
    or ("status" = 'running' and "started_at" is not null and "finished_at" is null)
    or ("status" in ('completed','failed','cancelled','interrupted') and "finished_at" is not null)
  ),
  CONSTRAINT "executions_error_check" CHECK ("error" is null or "status" in ('failed','interrupted'))
);
--> statement-breakpoint
CREATE TABLE "execution_steps" (
  "id" uuid PRIMARY KEY NOT NULL,
  "execution_id" uuid NOT NULL,
  "node_id" uuid NOT NULL,
  "tool_id" text NOT NULL,
  "tool_version" text NOT NULL,
  "attempt" integer NOT NULL,
  "status" text NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "input_context" jsonb NOT NULL,
  "output_contexts" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "error" jsonb,
  "idempotency_key" text,
  CONSTRAINT "execution_steps_execution_node_attempt_unique" UNIQUE("execution_id","node_id","attempt"),
  CONSTRAINT "execution_steps_attempt_check" CHECK ("attempt" > 0),
  CONSTRAINT "execution_steps_status_check" CHECK ("status" in ('queued','running','completed','failed','cancelled','interrupted')),
  CONSTRAINT "execution_steps_timing_check" CHECK (
    ("status" = 'queued' and "started_at" is null and "finished_at" is null)
    or ("status" = 'running' and "started_at" is not null and "finished_at" is null)
    or ("status" in ('completed','failed','cancelled','interrupted') and "finished_at" is not null)
  )
);
--> statement-breakpoint
CREATE TABLE "provenance_edges" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "execution_id" uuid NOT NULL,
  "from_context_id" uuid NOT NULL,
  "to_context_id" uuid NOT NULL,
  "node_id" uuid NOT NULL,
  CONSTRAINT "provenance_edges_execution_context_node_unique" UNIQUE("execution_id","from_context_id","to_context_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "execution_receipts" (
  "execution_id" uuid PRIMARY KEY NOT NULL,
  "receipt" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_owner_id_owner_accounts_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner_accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_owner_id_owner_accounts_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner_accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_workflow_definition_id_workflow_definitions_id_fk" FOREIGN KEY ("workflow_definition_id") REFERENCES "public"."workflow_definitions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "provenance_edges" ADD CONSTRAINT "provenance_edges_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "execution_receipts" ADD CONSTRAINT "execution_receipts_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION "phase3_prevent_immutable_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'immutable phase 3 record cannot be changed' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "workflow_definitions_immutable"
BEFORE UPDATE OR DELETE ON "workflow_definitions"
FOR EACH ROW EXECUTE FUNCTION "phase3_prevent_immutable_mutation"();
--> statement-breakpoint
CREATE TRIGGER "execution_receipts_immutable"
BEFORE UPDATE OR DELETE ON "execution_receipts"
FOR EACH ROW EXECUTE FUNCTION "phase3_prevent_immutable_mutation"();
