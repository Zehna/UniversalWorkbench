import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabasePool,
  createDatabasePool,
  migrateDatabase,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

const pool = createDatabasePool(databaseUrl);

async function resetPublicSchema() {
  await pool.query("drop schema if exists public cascade");
  await pool.query("create schema public");
}

async function insertOwner() {
  const id = randomUUID();
  await pool.query(
    `insert into owner_accounts
      (id, singleton_key, username, password_algorithm, password_salt, password_hash, password_parameters)
     values ($1, 1, $2, 'argon2id', 'salt', 'hash', '{}'::jsonb)`,
    [id, `owner-${id}`],
  );
  return id;
}

beforeEach(async () => {
  await resetPublicSchema();
});

afterAll(async () => {
  await resetPublicSchema();
  await closeDatabasePool(pool);
});

describe("phase 1 database migration", () => {
  it("creates the owned Phase 1 tables and can run twice", async () => {
    await migrateDatabase(pool);
    await migrateDatabase(pool);

    const result = await pool.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public'
        order by table_name`,
    );

    expect(result.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        "action_audit",
        "artifacts",
        "auth_sessions",
        "document_revisions",
        "documents",
        "owner_accounts",
        "projects",
      ]),
    );
  });

  it("enforces one owner account", async () => {
    await migrateDatabase(pool);
    await insertOwner();

    await expect(
      pool.query(
        `insert into owner_accounts
          (id, singleton_key, username, password_algorithm, password_salt, password_hash, password_parameters)
         values ($1, 1, $2, 'argon2id', 'salt', 'hash', '{}'::jsonb)`,
        [randomUUID(), `owner-${randomUUID()}`],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("keeps session token digests unique", async () => {
    await migrateDatabase(pool);
    const ownerId = await insertOwner();
    const tokenHash = "a".repeat(64);

    await pool.query(
      `insert into auth_sessions
        (id, owner_id, token_hash, expires_at)
       values ($1, $2, $3, now() + interval '1 day')`,
      [randomUUID(), ownerId, tokenHash],
    );

    await expect(
      pool.query(
        `insert into auth_sessions
          (id, owner_id, token_hash, expires_at)
         values ($1, $2, $3, now() + interval '1 day')`,
        [randomUUID(), ownerId, tokenHash],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("keeps document revision numbers unique per document", async () => {
    await migrateDatabase(pool);
    const ownerId = await insertOwner();
    const projectId = randomUUID();
    const documentId = randomUUID();

    await pool.query(
      "insert into projects (id, owner_id, name) values ($1, $2, 'Project')",
      [projectId, ownerId],
    );
    await pool.query(
      "insert into documents (id, project_id, kind, title) values ($1, $2, 'note', 'Note')",
      [documentId, projectId],
    );
    await pool.query(
      `insert into document_revisions
        (id, document_id, revision_number, content, metadata)
       values ($1, $2, 1, '{"body":"one"}'::jsonb, '{}'::jsonb)`,
      [randomUUID(), documentId],
    );

    await expect(
      pool.query(
        `insert into document_revisions
          (id, document_id, revision_number, content, metadata)
         values ($1, $2, 1, '{"body":"two"}'::jsonb, '{}'::jsonb)`,
        [randomUUID(), documentId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("enforces the project owner foreign key", async () => {
    await migrateDatabase(pool);

    await expect(
      pool.query(
        "insert into projects (id, owner_id, name) values ($1, $2, 'Orphan')",
        [randomUUID(), randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
