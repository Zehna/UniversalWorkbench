import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { redactSecrets } from "@uw/shared";

export interface VaultStore {
  put(ownerId: string, name: string, plaintext: string): Promise<void>;
  get(ownerId: string, name: string): Promise<string | null>;
  remove(ownerId: string, name: string): Promise<void>;
  list(ownerId: string): Promise<string[]>;
}

export class VaultNotFoundError extends Error {
  constructor(message = "Secret not found") {
    super(message);
    this.name = "VaultNotFoundError";
  }
}

export class VaultUnavailableError extends Error {
  constructor(message = "Vault is not configured") {
    super(message);
    this.name = "VaultUnavailableError";
  }
}

export class VaultValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultValidationError";
  }
}

export const VAULT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const VAULT_VALUE_MIN_BYTES = 1;
export const VAULT_VALUE_MAX_BYTES = 8192;

function buildAad(ownerId: string, name: string): Buffer {
  return Buffer.from(`vault:v1\0${ownerId}\0${name}`, "utf8");
}

interface Keyring {
  keys: Map<number, Buffer>;
  newestVersion: number;
}

function parseKeyB64(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(trimmed, "base64");
  } catch {
    return null;
  }
  if (decoded.byteLength !== 32) return null;
  // Reject non-canonical base64 (wrong lengths, bad chars) without leaking bytes.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  return decoded;
}

/** Parse the active keyring. `VAULT_MASTER_KEYS` wins; legacy `VAULT_MASTER_KEY` is version 1. */
export function loadVaultKeyring(): Keyring {
  const multi = process.env.VAULT_MASTER_KEYS;
  if (multi !== undefined && multi.trim().length > 0) {
    const keys = new Map<number, Buffer>();
    for (const entry of multi.split(",")) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) throw new VaultUnavailableError();
      const separator = trimmed.indexOf(":");
      if (separator <= 0) throw new VaultUnavailableError();
      const versionRaw = trimmed.slice(0, separator).trim();
      const keyRaw = trimmed.slice(separator + 1).trim();
      if (!/^[1-9][0-9]*$/.test(versionRaw)) throw new VaultUnavailableError();
      const version = Number.parseInt(versionRaw, 10);
      if (!Number.isSafeInteger(version)) throw new VaultUnavailableError();
      const key = parseKeyB64(keyRaw);
      if (!key) throw new VaultUnavailableError();
      // Last-wins for duplicate versions; newest is the highest numeric version.
      keys.set(version, key);
    }
    if (keys.size === 0) throw new VaultUnavailableError();
    return { keys, newestVersion: Math.max(...keys.keys()) };
  }

  const legacy = process.env.VAULT_MASTER_KEY;
  if (legacy !== undefined && legacy.trim().length > 0) {
    const key = parseKeyB64(legacy);
    if (!key) throw new VaultUnavailableError();
    return { keys: new Map([[1, key]]), newestVersion: 1 };
  }

  throw new VaultUnavailableError();
}

export function getVaultKeyringStatus(): {
  configured: boolean;
  newestVersion: number | null;
} {
  try {
    const keyring = loadVaultKeyring();
    return { configured: true, newestVersion: keyring.newestVersion };
  } catch (error) {
    if (error instanceof VaultUnavailableError) {
      return { configured: false, newestVersion: null };
    }
    throw error;
  }
}

function validateName(name: string): void {
  if (!VAULT_NAME_PATTERN.test(name)) {
    throw new VaultValidationError(
      "Invalid secret name: use 1-128 chars [a-z0-9._-], starting alphanumeric",
    );
  }
}

function validateValue(value: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < VAULT_VALUE_MIN_BYTES || bytes > VAULT_VALUE_MAX_BYTES) {
    throw new VaultValidationError(
      "Invalid secret value: must be 1 byte-8 KiB UTF-8",
    );
  }
}

function encryptEnvelope(
  key: Buffer,
  ownerId: string,
  name: string,
  plaintext: string,
): { iv: Buffer; ciphertext: Buffer; authTag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(buildAad(ownerId, name));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return { iv, ciphertext, authTag: cipher.getAuthTag() };
}

function decryptEnvelope(
  key: Buffer,
  ownerId: string,
  name: string,
  iv: Buffer,
  ciphertext: Buffer,
  authTag: Buffer,
): string {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(buildAad(ownerId, name));
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Concealment: never surface OpenSSL text, byte offsets, or plaintext.
    throw new VaultNotFoundError();
  }
}

interface VaultRow {
  key_version: number;
  iv: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
}

export function createVaultStore(pool: Pool): VaultStore {
  return {
    async put(ownerId: string, name: string, plaintext: string): Promise<void> {
      try {
        validateName(name);
        validateValue(plaintext);
        const keyring = loadVaultKeyring();
        const key = keyring.keys.get(keyring.newestVersion);
        if (!key) throw new VaultUnavailableError();
        const { iv, ciphertext, authTag } = encryptEnvelope(
          key,
          ownerId,
          name,
          plaintext,
        );
        await pool.query(
          `insert into vault_secrets (owner_id, name, key_version, iv, ciphertext, auth_tag, updated_at)
           values ($1, $2, $3, $4, $5, $6, now())
           on conflict (owner_id, name) do update set
             key_version = excluded.key_version,
             iv = excluded.iv,
             ciphertext = excluded.ciphertext,
             auth_tag = excluded.auth_tag,
             updated_at = now()`,
          [ownerId, name, keyring.newestVersion, iv, ciphertext, authTag],
        );
      } catch (error) {
        if (
          error instanceof VaultValidationError ||
          error instanceof VaultUnavailableError
        ) {
          throw error;
        }
        // Scrub any chance of the plaintext travelling in an error boundary.
        throw redactSecrets(error, [plaintext]) as unknown as Error;
      }
    },

    async get(ownerId: string, name: string): Promise<string | null> {
      if (!VAULT_NAME_PATTERN.test(name)) throw new VaultNotFoundError();
      const keyring = loadVaultKeyring();
      const result = await pool.query<VaultRow>(
        "select key_version, iv, ciphertext, auth_tag from vault_secrets where owner_id = $1 and name = $2 limit 1",
        [ownerId, name],
      );
      const row = result.rows[0];
      if (!row) return null;
      const key = keyring.keys.get(row.key_version);
      // Unknown version (key dropped before rekey finished) fails closed as concealment.
      if (!key) throw new VaultNotFoundError();
      return decryptEnvelope(
        key,
        ownerId,
        name,
        row.iv,
        row.ciphertext,
        row.auth_tag,
      );
    },

    async remove(ownerId: string, name: string): Promise<void> {
      validateName(name);
      // Removal needs a configured keyring so a misconfigured host fails closed
      // instead of silently reporting success.
      loadVaultKeyring();
      await pool.query(
        "delete from vault_secrets where owner_id = $1 and name = $2",
        [ownerId, name],
      );
    },

    async list(ownerId: string): Promise<string[]> {
      loadVaultKeyring();
      const result = await pool.query<{ name: string }>(
        "select name from vault_secrets where owner_id = $1 order by name",
        [ownerId],
      );
      // Names only — ciphertext material never leaves the repository.
      return result.rows.map((row) => row.name);
    },
  };
}

export interface VaultStats {
  totalRows: number;
  perVersionCounts: Record<string, number>;
}

export async function getVaultStats(pool: Pool): Promise<VaultStats> {
  loadVaultKeyring();
  const total = await pool.query<{ count: string }>(
    "select count(*)::text as count from vault_secrets",
  );
  const perVersion = await pool.query<{ key_version: number; count: string }>(
    "select key_version, count(*)::text as count from vault_secrets group by key_version order by key_version",
  );
  const perVersionCounts: Record<string, number> = {};
  for (const row of perVersion.rows) {
    perVersionCounts[String(row.key_version)] = Number.parseInt(row.count, 10);
  }
  return {
    totalRows: Number.parseInt(total.rows[0]?.count ?? "0", 10),
    perVersionCounts,
  };
}

/** Dry-run: report version distribution without touching data. */
export async function dryRunVaultRekey(pool: Pool): Promise<VaultStats> {
  return getVaultStats(pool);
}

export interface RekeyResult extends VaultStats {
  rekeyed: number;
  failed: number;
}

/**
 * Re-encrypt every row not on the newest version. One transaction per row
 * (SELECT ... FOR UPDATE, decrypt-with-old, encrypt-with-new). Idempotent:
 * re-running after completion rekeys zero rows. Logs only ownerless totals.
 * Rows that cannot be rotated (corrupted tag, missing old key, write
 * failure) are left on their old version and counted in `failed` — never
 * skipped silently. No owner ID, plaintext, or key material is logged or
 * returned.
 */
export async function rekeyVault(pool: Pool): Promise<RekeyResult> {
  const keyring = loadVaultKeyring();
  const newestKey = keyring.keys.get(keyring.newestVersion);
  if (!newestKey) throw new VaultUnavailableError();

  const before = await getVaultStats(pool);
  const rows = await pool.query<VaultRow & { owner_id: string; name: string }>(
    "select owner_id, name, key_version, iv, ciphertext, auth_tag from vault_secrets where key_version != $1 order by owner_id, name",
    [keyring.newestVersion],
  );

  let rekeyed = 0;
  let failed = 0;
  for (const row of rows.rows) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const locked = await client.query<VaultRow>(
        "select key_version, iv, ciphertext, auth_tag from vault_secrets where owner_id = $1 and name = $2 for update",
        [row.owner_id, row.name],
      );
      const current = locked.rows[0];
      if (!current || current.key_version === keyring.newestVersion) {
        await client.query("rollback");
        continue;
      }
      const oldKey = keyring.keys.get(current.key_version);
      if (!oldKey) {
        // Old key already dropped: leave the row for operator recovery.
        await client.query("rollback");
        failed += 1;
        continue;
      }
      let plaintext: string;
      try {
        plaintext = decryptEnvelope(
          oldKey,
          row.owner_id,
          row.name,
          current.iv,
          current.ciphertext,
          current.auth_tag,
        );
      } catch {
        await client.query("rollback");
        failed += 1;
        continue;
      }
      const { iv, ciphertext, authTag } = encryptEnvelope(
        newestKey,
        row.owner_id,
        row.name,
        plaintext,
      );
      await client.query(
        `update vault_secrets set key_version = $3, iv = $4, ciphertext = $5, auth_tag = $6, updated_at = now()
          where owner_id = $1 and name = $2`,
        [
          row.owner_id,
          row.name,
          keyring.newestVersion,
          iv,
          ciphertext,
          authTag,
        ],
      );
      await client.query("commit");
      rekeyed += 1;
    } catch {
      try {
        await client.query("rollback");
      } catch {
        // Ignore rollback failures; the row stays on its old version.
      }
      failed += 1;
    } finally {
      client.release();
    }
  }

  const after = await getVaultStats(pool);
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      event: "vault.rekey",
      fromVersions: Object.keys(before.perVersionCounts).sort(),
      to: keyring.newestVersion,
      totalRows: after.totalRows,
      rekeyed,
      failed,
    }),
  );
  return {
    totalRows: after.totalRows,
    perVersionCounts: after.perVersionCounts,
    rekeyed,
    failed,
  };
}

export async function countVaultRows(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "select count(*)::text as count from vault_secrets",
  );
  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
}
