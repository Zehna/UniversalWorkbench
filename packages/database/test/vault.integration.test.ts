import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabasePool,
  createDatabasePool,
  migrateDatabase,
} from "../src/index.js";
import {
  createVaultStore,
  dryRunVaultRekey,
  getVaultKeyringStatus,
  rekeyVault,
  VaultNotFoundError,
  VaultUnavailableError,
} from "../src/repositories/vault.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

const pool = createDatabasePool(databaseUrl);

function makeKeyB64(): string {
  return randomBytes(32).toString("base64");
}

function setKeyring(
  versions: Array<{ version: number; keyB64: string }>,
): void {
  process.env.VAULT_MASTER_KEYS = versions
    .map((v) => `${v.version}:${v.keyB64}`)
    .join(",");
  delete process.env.VAULT_MASTER_KEY;
}

let savedKeyring: string | undefined;
let savedLegacy: string | undefined;

async function resetDatabaseSchemas(): Promise<void> {
  await pool.query("drop schema if exists public cascade");
  await pool.query("drop schema if exists drizzle cascade");
  await pool.query("create schema public");
}

beforeEach(async () => {
  savedKeyring = process.env.VAULT_MASTER_KEYS;
  savedLegacy = process.env.VAULT_MASTER_KEY;
  await resetDatabaseSchemas();
  await migrateDatabase(pool);
});

afterAll(async () => {
  if (savedKeyring === undefined) delete process.env.VAULT_MASTER_KEYS;
  else process.env.VAULT_MASTER_KEYS = savedKeyring;
  if (savedLegacy === undefined) delete process.env.VAULT_MASTER_KEY;
  else process.env.VAULT_MASTER_KEY = savedLegacy;
  await resetDatabaseSchemas();
  await closeDatabasePool(pool);
});

function restoreEnvAfterEach(): void {
  if (savedKeyring === undefined) delete process.env.VAULT_MASTER_KEYS;
  else process.env.VAULT_MASTER_KEYS = savedKeyring;
  if (savedLegacy === undefined) delete process.env.VAULT_MASTER_KEY;
  else process.env.VAULT_MASTER_KEY = savedLegacy;
}

describe("vault migration", () => {
  it("creates vault_secrets with envelope columns and unique owner+name", async () => {
    const keyB64 = makeKeyB64();
    setKeyring([{ version: 1, keyB64 }]);
    try {
      const columns = await pool.query<{
        column_name: string;
        is_nullable: string;
      }>(
        `select column_name, is_nullable from information_schema.columns
          where table_schema = 'public' and table_name = 'vault_secrets'
          order by column_name`,
      );
      const byName = new Map(
        columns.rows.map((r) => [r.column_name, r.is_nullable]),
      );
      expect(byName.get("owner_id")).toBe("NO");
      expect(byName.get("name")).toBe("NO");
      expect(byName.get("key_version")).toBe("NO");
      expect(byName.get("iv")).toBe("NO");
      expect(byName.get("ciphertext")).toBe("NO");
      expect(byName.get("auth_tag")).toBe("NO");

      const ownerId = randomUUID();
      const store = createVaultStore(pool);
      await store.put(ownerId, "apikey", "value-one");
      await expect(
        store.put(ownerId, "apikey", "value-two"),
      ).resolves.toBeUndefined();
      // second put is upsert; uniqueness enforced at row level (only one row)
      const count = await pool.query<{ count: string }>(
        "select count(*)::text as count from vault_secrets where owner_id = $1",
        [ownerId],
      );
      expect(count.rows[0]?.count).toBe("1");
    } finally {
      restoreEnvAfterEach();
    }
  });

  it("isolates owners with the same secret name", async () => {
    const keyB64 = makeKeyB64();
    setKeyring([{ version: 1, keyB64 }]);
    try {
      const store = createVaultStore(pool);
      const ownerA = randomUUID();
      const ownerB = randomUUID();
      await store.put(ownerA, "shared", "alpha");
      await store.put(ownerB, "shared", "beta");
      await expect(store.get(ownerA, "shared")).resolves.toBe("alpha");
      await expect(store.get(ownerB, "shared")).resolves.toBe("beta");
    } finally {
      restoreEnvAfterEach();
    }
  });
});

describe("vault crypto envelope", () => {
  it("round-trips put→get and lists names only", async () => {
    const keyB64 = makeKeyB64();
    setKeyring([{ version: 1, keyB64 }]);
    try {
      const store = createVaultStore(pool);
      const ownerId = randomUUID();
      const plaintext = `secret-${randomUUID()}`;
      await store.put(ownerId, "openai", plaintext);
      await expect(store.get(ownerId, "openai")).resolves.toBe(plaintext);
      await expect(store.list(ownerId)).resolves.toEqual(["openai"]);
      const listed = await store.list(ownerId);
      expect(JSON.stringify(listed)).not.toContain(plaintext);
    } finally {
      restoreEnvAfterEach();
    }
  });

  it("encrypts the same plaintext twice with different IV/ciphertext", async () => {
    const keyB64 = makeKeyB64();
    setKeyring([{ version: 1, keyB64 }]);
    try {
      const store = createVaultStore(pool);
      const ownerId = randomUUID();
      await store.put(ownerId, "first", "same-value");
      await store.put(ownerId, "second", "same-value");
      const rows = await pool.query<{
        name: string;
        iv: Buffer;
        ciphertext: Buffer;
      }>(
        "select name, iv, ciphertext from vault_secrets where owner_id = $1 order by name",
        [ownerId],
      );
      expect(rows.rows).toHaveLength(2);
      const [a, b] = rows.rows;
      expect(a!.iv.equals(b!.iv)).toBe(false);
      expect(a!.ciphertext.equals(b!.ciphertext)).toBe(false);
      expect(a!.iv.byteLength).toBe(12);
      const tags = await pool.query<{ auth_tag: Buffer }>(
        "select auth_tag from vault_secrets where owner_id = $1",
        [ownerId],
      );
      for (const row of tags.rows) expect(row.auth_tag.byteLength).toBe(16);
    } finally {
      restoreEnvAfterEach();
    }
  });

  it("fails closed on tampered auth_tag without leaking plaintext", async () => {
    const keyB64 = makeKeyB64();
    setKeyring([{ version: 1, keyB64 }]);
    let plaintext = "";
    try {
      const store = createVaultStore(pool);
      const ownerId = randomUUID();
      plaintext = `tamper-${randomUUID()}`;
      await store.put(ownerId, "target", plaintext);
      await pool.query(
        "update vault_secrets set auth_tag = $1 where owner_id = $2 and name = 'target'",
        [randomBytes(16), ownerId],
      );
      const error = await store.get(ownerId, "target").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(VaultNotFoundError);
      const message =
        error instanceof Error
          ? error.message + String((error as { stack?: string }).stack ?? "")
          : String(error);
      expect(message).not.toContain(plaintext);
      expect(message).not.toMatch(/EVP|ossl|auth/i);
    } finally {
      restoreEnvAfterEach();
    }
  });

  it("fails closed when ciphertext is copied to another owner/name (AAD bind)", async () => {
    const keyB64 = makeKeyB64();
    setKeyring([{ version: 1, keyB64 }]);
    let plaintext = "";
    try {
      const store = createVaultStore(pool);
      const ownerA = randomUUID();
      const ownerB = randomUUID();
      plaintext = `aad-${randomUUID()}`;
      await store.put(ownerA, "original", plaintext);
      const row = await pool.query(
        "select key_version, iv, ciphertext, auth_tag from vault_secrets where owner_id = $1 and name = 'original'",
        [ownerA],
      );
      const source = row.rows[0] as {
        key_version: number;
        iv: Buffer;
        ciphertext: Buffer;
        auth_tag: Buffer;
      };
      await pool.query(
        `insert into vault_secrets (owner_id, name, key_version, iv, ciphertext, auth_tag)
         values ($1, 'copied', $2, $3, $4, $5)`,
        [
          ownerB,
          source.key_version,
          source.iv,
          source.ciphertext,
          source.auth_tag,
        ],
      );
      const error = await store.get(ownerB, "copied").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(VaultNotFoundError);
      expect(
        error instanceof Error ? error.message : String(error),
      ).not.toContain(plaintext);

      // same-owner different-name copy must also fail
      await pool.query(
        `insert into vault_secrets (owner_id, name, key_version, iv, ciphertext, auth_tag)
         values ($1, 'renamed', $2, $3, $4, $5)`,
        [
          ownerA,
          source.key_version,
          source.iv,
          source.ciphertext,
          source.auth_tag,
        ],
      );
      const renamed = await store
        .get(ownerA, "renamed")
        .catch((e: unknown) => e);
      expect(renamed).toBeInstanceOf(VaultNotFoundError);
    } finally {
      restoreEnvAfterEach();
    }
  });

  it("keeps v1 rows readable after v2 is appended (newest encrypts, old decrypts)", async () => {
    const v1 = makeKeyB64();
    const v2 = makeKeyB64();
    let plaintext = "";
    try {
      setKeyring([{ version: 1, keyB64: v1 }]);
      const ownerId = randomUUID();
      plaintext = `rotate-${randomUUID()}`;
      await createVaultStore(pool).put(ownerId, "legacy", plaintext);

      setKeyring([
        { version: 1, keyB64: v1 },
        { version: 2, keyB64: v2 },
      ]);
      await expect(createVaultStore(pool).get(ownerId, "legacy")).resolves.toBe(
        plaintext,
      );

      // new puts encrypt under newest version
      await createVaultStore(pool).put(ownerId, "fresh", "new-value");
      const versions = await pool.query<{ name: string; key_version: number }>(
        "select name, key_version from vault_secrets where owner_id = $1 order by name",
        [ownerId],
      );
      const byName = new Map(versions.rows.map((r) => [r.name, r.key_version]));
      expect(byName.get("legacy")).toBe(1);
      expect(byName.get("fresh")).toBe(2);
      expect(getVaultKeyringStatus().newestVersion).toBe(2);
    } finally {
      restoreEnvAfterEach();
    }
  });

  it("fail-closes when the keyring is missing or invalid without leaking key material", async () => {
    const keyB64 = makeKeyB64();
    setKeyring([{ version: 1, keyB64 }]);
    const ownerId = randomUUID();
    await createVaultStore(pool).put(ownerId, "k", "v");
    const rowBefore = await pool.query(
      "select * from vault_secrets where owner_id = $1",
      [ownerId],
    );

    delete process.env.VAULT_MASTER_KEYS;
    delete process.env.VAULT_MASTER_KEY;
    try {
      await expect(
        createVaultStore(pool).get(ownerId, "k"),
      ).rejects.toBeInstanceOf(VaultUnavailableError);
      await expect(createVaultStore(pool).list(ownerId)).rejects.toBeInstanceOf(
        VaultUnavailableError,
      );
      await expect(
        createVaultStore(pool).put(randomUUID(), "x", "y"),
      ).rejects.toBeInstanceOf(VaultUnavailableError);
    } finally {
      restoreEnvAfterEach();
    }

    process.env.VAULT_MASTER_KEYS = "not-a-valid-keyring";
    try {
      const error = await createVaultStore(pool)
        .get(ownerId, "k")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(VaultUnavailableError);
      const text =
        error instanceof Error
          ? `${error.message} ${String((error as { stack?: string }).stack ?? "")}`
          : String(error);
      expect(text).not.toContain(keyB64);
    } finally {
      restoreEnvAfterEach();
    }
    expect(rowBefore.rows).toHaveLength(1);
  });

  it("accepts legacy VAULT_MASTER_KEY as version 1 and prefers VAULT_MASTER_KEYS when both set", async () => {
    const legacy = makeKeyB64();
    const v1 = makeKeyB64();
    const v2 = makeKeyB64();
    try {
      delete process.env.VAULT_MASTER_KEYS;
      process.env.VAULT_MASTER_KEY = legacy;
      const ownerId = randomUUID();
      await createVaultStore(pool).put(ownerId, "leg", "legacy-value");
      await expect(createVaultStore(pool).get(ownerId, "leg")).resolves.toBe(
        "legacy-value",
      );
      expect(getVaultKeyringStatus().newestVersion).toBe(1);

      process.env.VAULT_MASTER_KEYS = `1:${v1},2:${v2}`;
      expect(getVaultKeyringStatus().newestVersion).toBe(2);
    } finally {
      restoreEnvAfterEach();
    }
  });

  it("rejects invalid names and enforces 1 byte–8 KiB UTF-8 values", async () => {
    const keyB64 = makeKeyB64();
    setKeyring([{ version: 1, keyB64 }]);
    try {
      const store = createVaultStore(pool);
      const ownerId = randomUUID();
      await expect(store.put(ownerId, "BadName", "x")).rejects.toMatchObject({
        name: "VaultValidationError",
      });
      await expect(store.put(ownerId, "../escape", "x")).rejects.toMatchObject({
        name: "VaultValidationError",
      });
      await expect(store.put(ownerId, "ok", "")).rejects.toMatchObject({
        name: "VaultValidationError",
      });
      await expect(
        store.put(ownerId, "ok", "x".repeat(8193)),
      ).rejects.toMatchObject({
        name: "VaultValidationError",
      });
      await store.put(ownerId, "ok", "x".repeat(8192));
      await expect(store.get(ownerId, "ok")).resolves.toBe("x".repeat(8192));
    } finally {
      restoreEnvAfterEach();
    }
  });
});

describe("vault rekey", () => {
  it("dry-run reports counts without modifying rows; real run moves to newest; rerun is no-op; v1 removable afterwards", async () => {
    const v1 = makeKeyB64();
    const v2 = makeKeyB64();
    setKeyring([{ version: 1, keyB64: v1 }]);
    const ownerId = randomUUID();
    const first = `rekey-a-${randomUUID()}`;
    const second = `rekey-b-${randomUUID()}`;
    const store = createVaultStore(pool);
    await store.put(ownerId, "a", first);
    await store.put(ownerId, "b", second);
    const before = await pool.query<{
      iv: Buffer;
      ciphertext: Buffer;
      auth_tag: Buffer;
    }>(
      "select iv, ciphertext, auth_tag from vault_secrets where owner_id = $1 order by name",
      [ownerId],
    );

    setKeyring([
      { version: 1, keyB64: v1 },
      { version: 2, keyB64: v2 },
    ]);

    const dry = await dryRunVaultRekey(pool);
    expect(dry.totalRows).toBe(2);
    expect(dry.perVersionCounts).toMatchObject({ "1": 2 });
    const unchanged = await pool.query<{
      iv: Buffer;
      ciphertext: Buffer;
      auth_tag: Buffer;
    }>(
      "select iv, ciphertext, auth_tag from vault_secrets where owner_id = $1 order by name",
      [ownerId],
    );
    expect(unchanged.rows[0]!.iv.equals(before.rows[0]!.iv)).toBe(true);
    expect(
      unchanged.rows[0]!.ciphertext.equals(before.rows[0]!.ciphertext),
    ).toBe(true);

    const result = await rekeyVault(pool);
    expect(result.rekeyed).toBe(2);
    const after = await pool.query<{ name: string; key_version: number }>(
      "select name, key_version from vault_secrets where owner_id = $1",
      [ownerId],
    );
    expect(after.rows.every((r) => r.key_version === 2)).toBe(true);
    await expect(createVaultStore(pool).get(ownerId, "a")).resolves.toBe(first);
    await expect(createVaultStore(pool).get(ownerId, "b")).resolves.toBe(
      second,
    );

    const rerun = await rekeyVault(pool);
    expect(rerun.rekeyed).toBe(0);

    // v1 can be removed after all rows are on v2
    setKeyring([{ version: 2, keyB64: v2 }]);
    await expect(createVaultStore(pool).get(ownerId, "a")).resolves.toBe(first);
    await expect(createVaultStore(pool).get(ownerId, "b")).resolves.toBe(
      second,
    );
    restoreEnvAfterEach();
  });

  it("reports failure when a row has a corrupted authentication tag and leaves it unrotated", async () => {
    const v1 = makeKeyB64();
    const v2 = makeKeyB64();
    setKeyring([{ version: 1, keyB64: v1 }]);
    const ownerId = randomUUID();
    const goodPlaintext = `rekey-good-${randomUUID()}`;
    const badPlaintext = `rekey-bad-${randomUUID()}`;
    const store = createVaultStore(pool);
    await store.put(ownerId, "good", goodPlaintext);
    await store.put(ownerId, "bad", badPlaintext);

    setKeyring([
      { version: 1, keyB64: v1 },
      { version: 2, keyB64: v2 },
    ]);
    await pool.query(
      "update vault_secrets set auth_tag = $1 where owner_id = $2 and name = 'bad'",
      [randomBytes(16), ownerId],
    );

    const result = await rekeyVault(pool);
    expect(result.rekeyed).toBe(1);
    expect(result.failed).toBe(1);
    const versions = await pool.query<{ name: string; key_version: number }>(
      "select name, key_version from vault_secrets where owner_id = $1 order by name",
      [ownerId],
    );
    const byName = new Map(versions.rows.map((r) => [r.name, r.key_version]));
    expect(byName.get("good")).toBe(2);
    expect(byName.get("bad")).toBe(1);
    await expect(createVaultStore(pool).get(ownerId, "good")).resolves.toBe(
      goodPlaintext,
    );
    const dumped = JSON.stringify(result);
    expect(dumped).not.toContain(goodPlaintext);
    expect(dumped).not.toContain(badPlaintext);
    expect(dumped).not.toContain(ownerId);
    restoreEnvAfterEach();
  });

  it("reports failure when the old version key is unavailable and leaves rows unrotated", async () => {
    const v1 = makeKeyB64();
    const v2 = makeKeyB64();
    setKeyring([{ version: 1, keyB64: v1 }]);
    const ownerId = randomUUID();
    const plaintext = `rekey-legacy-${randomUUID()}`;
    await createVaultStore(pool).put(ownerId, "legacy", plaintext);

    // v1 key dropped before rekey finished: row cannot be decrypted.
    setKeyring([{ version: 2, keyB64: v2 }]);
    const result = await rekeyVault(pool);
    expect(result.rekeyed).toBe(0);
    expect(result.failed).toBe(1);
    const versions = await pool.query<{ name: string; key_version: number }>(
      "select name, key_version from vault_secrets where owner_id = $1",
      [ownerId],
    );
    expect(versions.rows[0]?.key_version).toBe(1);
    const dumped = JSON.stringify(result);
    expect(dumped).not.toContain(plaintext);
    expect(dumped).not.toContain(ownerId);
    expect(dumped).not.toContain(v1);
    expect(dumped).not.toContain(v2);
    restoreEnvAfterEach();
  });
});
