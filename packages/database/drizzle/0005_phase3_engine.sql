CREATE TABLE "execution_requests" (
  "execution_id" uuid PRIMARY KEY NOT NULL,
  "granted_permissions" jsonb NOT NULL,
  "budget" jsonb NOT NULL,
  CONSTRAINT "execution_requests_permissions_check"
    CHECK (jsonb_typeof("granted_permissions") = 'array'),
  CONSTRAINT "execution_requests_budget_check"
    CHECK (jsonb_typeof("budget") = 'object')
);
--> statement-breakpoint
ALTER TABLE "execution_requests"
  ADD CONSTRAINT "execution_requests_execution_id_executions_id_fk"
  FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id")
  ON DELETE no action ON UPDATE no action;
