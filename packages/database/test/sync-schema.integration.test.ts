import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { SyncOperation } from "@uw/contracts";
import {
  closeDatabasePool,
  createDatabasePool,
  createPostgresSyncRepository,
  migrateDatabase,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

const pool = createDatabasePool(databaseUrl);

async function resetDatabaseSchemas() {
  await pool.query("drop schema if exists public cascade");
  await pool.query("drop schema if exists drizzle cascade");
  await pool.query("create schema public");
}

async function insertOwner() {
  const ownerId = randomUUID();
  await pool.query(
    `insert into owner_accounts
      (id, singleton_key, username, password_algorithm, password_salt, password_hash, password_parameters)
     values ($1, 1, $2, 'argon2id', 'salt', 'hash', '{}'::jsonb)`,
    [ownerId, `owner-${ownerId}`],
  );
  return ownerId;
}

function operation(
  deviceId: string,
  overrides: Partial<SyncOperation> = {},
): SyncOperation {
  const entityId = randomUUID();
  return {
    id: randomUUID(),
    deviceId,
    projectId: null,
    entityType: "project",
    entityId,
    action: "project.create",
    baseRevision: null,
    payload: { name: "Offline project" },
    createdAt: "2026-09-18T12:00:00.000Z",
    ...overrides,
  };
}

beforeEach(async () => {
  await resetDatabaseSchemas();
  await migrateDatabase(pool);
});

afterAll(async () => {
  await resetDatabaseSchemas();
  await closeDatabasePool(pool);
});

describe("Phase 2 sync persistence", () => {
  it("registers, touches, and revokes an owner-scoped device", async () => {
    const ownerId = await insertOwner();
    const repository = createPostgresSyncRepository(pool);
    const deviceId = randomUUID();
    const createdAt = new Date("2026-09-18T12:00:00.000Z");

    const created = await repository.registerDevice({
      id: deviceId,
      ownerId,
      name: "Phone",
      now: createdAt,
    });

    expect(created).toMatchObject({
      id: deviceId,
      ownerId,
      name: "Phone",
      revokedAt: null,
    });

    const touchedAt = new Date("2026-09-18T12:05:00.000Z");
    await repository.touchDevice(ownerId, deviceId, touchedAt);
    expect((await repository.getDevice(ownerId, deviceId))?.lastSeenAt).toEqual(
      touchedAt,
    );

    const revokedAt = new Date("2026-09-18T12:10:00.000Z");
    await repository.revokeDevice(ownerId, deviceId, revokedAt);
    expect((await repository.getDevice(ownerId, deviceId))?.revokedAt).toEqual(
      revokedAt,
    );
  });

  it("deduplicates an applied operation without advancing the cursor", async () => {
    const ownerId = await insertOwner();
    const repository = createPostgresSyncRepository(pool);
    const deviceId = randomUUID();
    const now = new Date("2026-09-18T12:00:00.000Z");
    await repository.registerDevice({
      id: deviceId,
      ownerId,
      name: "Phone",
      now,
    });

    const syncOperation = operation(deviceId);
    const input = {
      ownerId,
      operation: syncOperation,
      resultRevision: "1",
      change: {
        kind: "upsert" as const,
        revision: "1",
        payload: {
          id: syncOperation.entityId,
          name: "Offline project",
        },
      },
      now,
    };

    const first = await repository.persistAppliedOperation(input);
    const replay = await repository.persistAppliedOperation(input);

    expect(replay).toEqual(first);
    expect(await repository.getLatestCursor(ownerId)).toBe(first.cursor);
    expect(await repository.listChanges(ownerId, "0", 100)).toEqual([first]);
  });

  it("returns strictly increasing decimal cursors and only changes after the cursor", async () => {
    const ownerId = await insertOwner();
    const repository = createPostgresSyncRepository(pool);
    const deviceId = randomUUID();
    const now = new Date("2026-09-18T12:00:00.000Z");
    await repository.registerDevice({
      id: deviceId,
      ownerId,
      name: "Laptop",
      now,
    });

    const firstOperation = operation(deviceId);
    const first = await repository.persistAppliedOperation({
      ownerId,
      operation: firstOperation,
      resultRevision: "1",
      change: {
        kind: "upsert",
        revision: "1",
        payload: { id: firstOperation.entityId, name: "One" },
      },
      now,
    });

    const secondOperation = operation(deviceId);
    const second = await repository.persistAppliedOperation({
      ownerId,
      operation: secondOperation,
      resultRevision: "1",
      change: {
        kind: "upsert",
        revision: "1",
        payload: { id: secondOperation.entityId, name: "Two" },
      },
      now,
    });

    expect(BigInt(second.cursor)).toBeGreaterThan(BigInt(first.cursor));
    expect(await repository.listChanges(ownerId, first.cursor, 100)).toEqual([
      second,
    ]);
  });

  it("persists conflicts idempotently as conflict changes", async () => {
    const ownerId = await insertOwner();
    const repository = createPostgresSyncRepository(pool);
    const deviceId = randomUUID();
    const now = new Date("2026-09-18T12:00:00.000Z");
    await repository.registerDevice({
      id: deviceId,
      ownerId,
      name: "Tablet",
      now,
    });

    const syncOperation = operation(deviceId, {
      entityType: "document",
      action: "document.update",
      projectId: randomUUID(),
      baseRevision: randomUUID(),
      payload: { title: "Note", body: "offline edit" },
    });

    const input = {
      ownerId,
      operation: syncOperation,
      currentRevision: randomUUID(),
      change: {
        kind: "conflict" as const,
        revision: null,
        payload: {
          incoming: syncOperation.payload,
          current: { title: "Note", body: "server edit" },
        },
      },
      now,
    };

    const first = await repository.persistConflict(input);
    const replay = await repository.persistConflict(input);

    expect(first.kind).toBe("conflict");
    expect(replay).toEqual(first);
  });
});
