import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthService } from "@uw/auth";
import {
  closeDatabasePool,
  createDatabasePool,
  createVaultStore,
  migrateDatabase,
} from "@uw/database";
import { createApp } from "../src/app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

const pool = createDatabasePool(databaseUrl);

const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COOKIE = "uw_session=valid";

function authFor(ownerId: string | null) {
  const authService = {
    isInitialized: vi.fn().mockResolvedValue(true),
    setupOwner: vi.fn(),
    login: vi.fn(),
    resolveSession: vi.fn().mockResolvedValue(
      ownerId
        ? {
            id: ownerId,
            username: "owner",
            createdAt: new Date().toISOString(),
          }
        : null,
    ),
    logout: vi.fn(),
  } satisfies AuthService;
  return authService;
}

function appFor(ownerId: string | null) {
  return createApp({
    databaseReady: async () => true,
    authService: authFor(ownerId),
    sessionCookie: { name: "uw_session", secure: false, maxAgeSeconds: 604800 },
    vaultPool: pool,
  } as unknown as Parameters<typeof createApp>[0]);
}

function makeKeyB64(): string {
  return randomBytes(32).toString("base64");
}

let savedKeyring: string | undefined;
let savedLegacy: string | undefined;

async function resetSchemas(): Promise<void> {
  await pool.query("drop schema if exists public cascade");
  await pool.query("drop schema if exists drizzle cascade");
  await pool.query("create schema public");
}

function restoreEnv(): void {
  if (savedKeyring === undefined) delete process.env.VAULT_MASTER_KEYS;
  else process.env.VAULT_MASTER_KEYS = savedKeyring;
  if (savedLegacy === undefined) delete process.env.VAULT_MASTER_KEY;
  else process.env.VAULT_MASTER_KEY = savedLegacy;
}

beforeEach(async () => {
  savedKeyring = process.env.VAULT_MASTER_KEYS;
  savedLegacy = process.env.VAULT_MASTER_KEY;
  await resetSchemas();
  await migrateDatabase(pool);
});

afterAll(async () => {
  restoreEnv();
  await resetSchemas();
  await closeDatabasePool(pool);
});

describe("vault API", () => {
  it("put→list→delete round-trips names only and never returns plaintext in list", async () => {
    process.env.VAULT_MASTER_KEYS = `1:${makeKeyB64()}`;
    delete process.env.VAULT_MASTER_KEY;
    try {
      const app = appFor(OWNER_A);
      const plaintext = `api-value-${randomUUID()}`;
      const put = await request(app)
        .put("/api/vault/mykey")
        .set("Cookie", COOKIE)
        .send({ value: plaintext });
      expect(put.status).toBe(200);
      expect(put.body).toEqual({ name: "mykey" });

      const list = await request(app).get("/api/vault").set("Cookie", COOKIE);
      expect(list.status).toBe(200);
      expect(list.body).toEqual({ secrets: ["mykey"] });
      expect(JSON.stringify(list.body)).not.toContain(plaintext);

      const del = await request(app)
        .delete("/api/vault/mykey")
        .set("Cookie", COOKIE);
      expect(del.status).toBe(200);
      expect(del.body).toEqual({ deleted: true });

      const after = await request(app).get("/api/vault").set("Cookie", COOKIE);
      expect(after.body).toEqual({ secrets: [] });
    } finally {
      restoreEnv();
    }
  });

  it("conceals cross-owner secrets as 404", async () => {
    const keyB64 = makeKeyB64();
    process.env.VAULT_MASTER_KEYS = `1:${keyB64}`;
    delete process.env.VAULT_MASTER_KEY;
    try {
      const store = createVaultStore(pool);
      await store.put(OWNER_A, "private", "owner-a-value");
      const appB = appFor(OWNER_B);
      const listB = await request(appB).get("/api/vault").set("Cookie", COOKIE);
      expect(listB.status).toBe(200);
      expect(listB.body).toEqual({ secrets: [] });
      const delB = await request(appB)
        .delete("/api/vault/private")
        .set("Cookie", COOKIE);
      expect(delB.status).toBe(404);
      expect(delB.body.error.code).toBe("NOT_FOUND");
    } finally {
      restoreEnv();
    }
  });

  it("rejects oversize values with 413 and invalid names with 400", async () => {
    process.env.VAULT_MASTER_KEYS = `1:${makeKeyB64()}`;
    delete process.env.VAULT_MASTER_KEY;
    try {
      const app = appFor(OWNER_A);
      const big = await request(app)
        .put("/api/vault/big")
        .set("Cookie", COOKIE)
        .send({ value: "x".repeat(8193) });
      expect(big.status).toBe(413);
      expect(big.body.error.code).toBe("PAYLOAD_TOO_LARGE");

      const badName = await request(app)
        .put("/api/vault/BadName")
        .set("Cookie", COOKIE)
        .send({ value: "x" });
      expect(badName.status).toBe(400);

      const empty = await request(app)
        .put("/api/vault/empty")
        .set("Cookie", COOKIE)
        .send({ value: "" });
      expect(empty.status).toBe(400);
    } finally {
      restoreEnv();
    }
  });

  it("returns 503 without stack or key leak when the keyring is missing", async () => {
    const keyB64 = makeKeyB64();
    process.env.VAULT_MASTER_KEYS = `1:${keyB64}`;
    delete process.env.VAULT_MASTER_KEY;
    const app = appFor(OWNER_A);
    await request(app)
      .put("/api/vault/pre")
      .set("Cookie", COOKIE)
      .send({ value: "v" });

    delete process.env.VAULT_MASTER_KEYS;
    delete process.env.VAULT_MASTER_KEY;
    try {
      const list = await request(app).get("/api/vault").set("Cookie", COOKIE);
      expect(list.status).toBe(503);
      expect(list.body.error.code).toBe("VAULT_UNAVAILABLE");
      expect(JSON.stringify(list.body)).not.toMatch(/stack|EVP|ossl/i);
      expect(JSON.stringify(list.body)).not.toContain(keyB64);

      const put = await request(app)
        .put("/api/vault/x")
        .set("Cookie", COOKIE)
        .send({ value: "y" });
      expect(put.status).toBe(503);
    } finally {
      restoreEnv();
    }
  });

  it("never echoes raw plaintext in error bodies", async () => {
    process.env.VAULT_MASTER_KEYS = `1:${makeKeyB64()}`;
    delete process.env.VAULT_MASTER_KEY;
    try {
      const app = appFor(OWNER_A);
      const plaintext = `never-leak-${randomUUID()}-${randomBytes(8).toString("hex")}`;
      await request(app)
        .put("/api/vault/s1")
        .set("Cookie", COOKIE)
        .send({ value: plaintext });
      // tamper the row directly so reads fail closed
      await pool.query("update vault_secrets set auth_tag = $1", [
        randomBytes(16),
      ]);
      const store = createVaultStore(pool);
      // sanity: repository hides plaintext in its own errors
      const repoError = await store.get(OWNER_A, "s1").catch((e: unknown) => e);
      expect(
        JSON.stringify(
          repoError instanceof Error ? repoError.message : String(repoError),
        ),
      ).not.toContain(plaintext);
      // list must not contain plaintext even when rows are damaged
      const list = await request(app).get("/api/vault").set("Cookie", COOKIE);
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain(plaintext);
    } finally {
      restoreEnv();
    }
  });

  it("requires authentication on all vault routes", async () => {
    process.env.VAULT_MASTER_KEYS = `1:${makeKeyB64()}`;
    delete process.env.VAULT_MASTER_KEY;
    try {
      const app = appFor(null);
      await expect(request(app).get("/api/vault")).resolves.toMatchObject({
        status: 401,
      });
      await expect(
        request(app).put("/api/vault/k").send({ value: "v" }),
      ).resolves.toMatchObject({ status: 401 });
      await expect(request(app).delete("/api/vault/k")).resolves.toMatchObject({
        status: 401,
      });
    } finally {
      restoreEnv();
    }
  });

  it("exposes operator health without key bytes", async () => {
    const keyB64 = makeKeyB64();
    process.env.VAULT_MASTER_KEYS = `1:${keyB64}`;
    delete process.env.VAULT_MASTER_KEY;
    try {
      const app = appFor(OWNER_A);
      const healthy = await request(app)
        .get("/api/vault/health")
        .set("Cookie", COOKIE);
      expect(healthy.status).toBe(200);
      expect(healthy.body).toMatchObject({
        configured: true,
        newestVersion: 1,
      });
      expect(JSON.stringify(healthy.body)).not.toContain(keyB64);
    } finally {
      restoreEnv();
    }
  });
});
