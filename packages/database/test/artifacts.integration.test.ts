import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArtifactNotFoundError,
  createArtifactService,
  type ArtifactRepository,
} from "@uw/artifacts";
import { SystemClock, UuidGenerator } from "@uw/shared";
import { createLocalFilesystemStorage, type StorageBackend } from "@uw/storage";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabasePool,
  createDatabasePool,
  createPostgresArtifactRepository,
  createPostgresAuditRepository,
  migrateDatabase,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

const pool = createDatabasePool(databaseUrl);
const storageRoots: string[] = [];

async function resetDatabaseSchemas() {
  await pool.query("drop schema if exists public cascade");
  await pool.query("drop schema if exists drizzle cascade");
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

async function insertProject(ownerId: string) {
  const id = randomUUID();
  await pool.query(
    "insert into projects (id, owner_id, name) values ($1, $2, 'Artifact Project')",
    [id, ownerId],
  );
  return id;
}

async function createStorage() {
  const root = await mkdtemp(join(tmpdir(), "uw-artifacts-"));
  storageRoots.push(root);
  return createLocalFilesystemStorage(root);
}

async function createService(storage: StorageBackend) {
  return createArtifactService({
    artifacts: createPostgresArtifactRepository(pool),
    storage,
    audit: createPostgresAuditRepository(pool),
    clock: new SystemClock(),
    idGenerator: new UuidGenerator(),
  });
}

beforeEach(async () => {
  await resetDatabaseSchemas();
  await migrateDatabase(pool);
});

afterAll(async () => {
  await resetDatabaseSchemas();
  await closeDatabasePool(pool);
  await Promise.all(
    storageRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("immutable artifact service", () => {
  it("persists checksum, size and metadata and round-trips content", async () => {
    const ownerId = await insertOwner();
    const projectId = await insertProject(ownerId);
    const storage = await createStorage();
    const service = await createService(storage);
    const bytes = new TextEncoder().encode('{"answer":42}');
    const metadata = { source: "http-tool", label: "original" };
    const traceId = randomUUID();

    const created = await service.create(
      ownerId,
      projectId,
      {
        type: "api_response",
        mimeType: "application/json",
        bytes,
        metadata,
      },
      traceId,
    );

    const expectedHash = createHash("sha256").update(bytes).digest("hex");
    expect(created).toMatchObject({
      projectId,
      type: "api_response",
      schemaVersion: 1,
      mimeType: "application/json",
      checksumSha256: expectedHash,
      sizeBytes: bytes.byteLength,
      storageKey: `${projectId}/${created.id}/${expectedHash}`,
      metadata: { source: "http-tool", label: "original" },
    });

    metadata.label = "mutated-after-create";

    await expect(service.get(ownerId, projectId, created.id)).resolves.toEqual(
      created,
    );
    await expect(
      service.getContent(ownerId, projectId, created.id),
    ).resolves.toEqual(bytes);
    await expect(service.list(ownerId, projectId)).resolves.toEqual([created]);

    const stored = await pool.query<{
      checksum_sha256: string;
      size_bytes: string;
      metadata: Record<string, unknown>;
    }>(
      `select checksum_sha256, size_bytes, metadata
         from artifacts
        where id = $1`,
      [created.id],
    );
    expect(stored.rows[0]).toMatchObject({
      checksum_sha256: expectedHash,
      metadata: { source: "http-tool", label: "original" },
    });
    expect(Number(stored.rows[0]?.size_bytes)).toBe(bytes.byteLength);

    const audit = await pool.query<{
      action: string;
      project_id: string | null;
      target_id: string | null;
      trace_id: string;
      metadata: Record<string, unknown>;
    }>(
      "select action, project_id, target_id, trace_id, metadata from action_audit",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: "artifact.create",
      project_id: projectId,
      target_id: created.id,
      trace_id: traceId,
    });
    expect(JSON.stringify(audit.rows[0]?.metadata)).not.toContain("http-tool");
    expect(JSON.stringify(audit.rows[0]?.metadata)).not.toContain("original");
  });

  it("conceals artifacts outside the owner/project boundary", async () => {
    const ownerId = await insertOwner();
    const projectId = await insertProject(ownerId);
    const otherActorId = randomUUID();
    const otherProjectId = randomUUID();
    const storage = await createStorage();
    const service = await createService(storage);
    const created = await service.create(
      ownerId,
      projectId,
      {
        type: "text",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("private"),
        metadata: {},
      },
      randomUUID(),
    );

    await expect(
      service.get(otherActorId, projectId, created.id),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
    await expect(
      service.get(ownerId, otherProjectId, created.id),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
    await expect(
      service.getContent(otherActorId, projectId, created.id),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });

  it("removes newly written storage content when repository creation fails", async () => {
    const removed: string[] = [];
    const stored = new Map<string, Uint8Array>();
    const storage: StorageBackend = {
      async put({ key, bytes }) {
        stored.set(key, bytes);
      },
      async get(key) {
        const bytes = stored.get(key);
        if (!bytes) throw new Error("missing");
        return bytes;
      },
      async remove(key) {
        removed.push(key);
        stored.delete(key);
      },
    };
    const artifacts: ArtifactRepository = {
      async projectExists() {
        return true;
      },
      async create() {
        throw new Error("database insert failed");
      },
      async list() {
        return [];
      },
      async get() {
        return null;
      },
    };
    const service = createArtifactService({
      artifacts,
      storage,
      audit: {
        async record() {
          throw new Error("audit should not run");
        },
      },
      clock: new SystemClock(),
      idGenerator: new UuidGenerator(),
    });

    await expect(
      service.create(
        randomUUID(),
        randomUUID(),
        {
          type: "text",
          mimeType: "text/plain",
          bytes: new TextEncoder().encode("cleanup me"),
          metadata: {},
        },
        randomUUID(),
      ),
    ).rejects.toThrow("database insert failed");

    expect(stored.size).toBe(0);
    expect(removed).toHaveLength(1);
  });
});
