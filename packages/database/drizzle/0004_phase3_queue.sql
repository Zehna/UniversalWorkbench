CREATE TABLE "execution_queue" (
  "execution_id" uuid PRIMARY KEY NOT NULL,
  "available_at" timestamp with time zone NOT NULL,
  "enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_owner" text,
  "lease_token" uuid,
  "leased_until" timestamp with time zone,
  "attempts" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "execution_queue_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "execution_queue_lease_consistency_check" CHECK (
    ("lease_owner" is null and "lease_token" is null and "leased_until" is null)
    or ("lease_owner" is not null and "lease_token" is not null and "leased_until" is not null)
  )
);
--> statement-breakpoint
ALTER TABLE "execution_queue" ADD CONSTRAINT "execution_queue_execution_id_executions_id_fk"
  FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "execution_queue_ready_idx"
  ON "execution_queue" USING btree ("available_at", "enqueued_at", "execution_id");
--> statement-breakpoint
CREATE INDEX "execution_queue_lease_expiry_idx"
  ON "execution_queue" USING btree ("leased_until");
