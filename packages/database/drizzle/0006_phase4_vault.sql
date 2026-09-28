CREATE TABLE "vault_secrets" (
  "owner_id" uuid NOT NULL,
  "name" text NOT NULL,
  "key_version" integer NOT NULL,
  "iv" bytea NOT NULL,
  "ciphertext" bytea NOT NULL,
  "auth_tag" bytea NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "vault_secrets_key_version_check" CHECK ("key_version" > 0),
  CONSTRAINT "vault_secrets_iv_check" CHECK (octet_length("iv") = 12),
  CONSTRAINT "vault_secrets_ciphertext_check" CHECK (octet_length("ciphertext") > 0),
  CONSTRAINT "vault_secrets_auth_tag_check" CHECK (octet_length("auth_tag") = 16),
  CONSTRAINT "vault_secrets_owner_name_unique" UNIQUE("owner_id","name")
);
--> statement-breakpoint
CREATE INDEX "vault_secrets_owner_idx" ON "vault_secrets" USING btree ("owner_id");
--> statement-breakpoint
CREATE INDEX "vault_secrets_version_idx" ON "vault_secrets" USING btree ("key_version");
