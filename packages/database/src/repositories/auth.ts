import type {
  AuthRepository,
  OwnerCredentialRecord,
  PasswordHashParameters,
  SessionRecord,
  StoredPasswordHash,
} from "@uw/auth";
import type { Pool, QueryResultRow } from "pg";

interface OwnerRow extends QueryResultRow {
  id: string;
  username: string;
  password_algorithm: string;
  password_salt: string;
  password_hash: string;
  password_parameters: unknown;
  created_at: Date;
}

interface SessionRow extends QueryResultRow {
  id: string;
  owner_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
}

function parsePasswordParameters(value: unknown): PasswordHashParameters {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid password hash parameters in database");
  }

  const record = value as Record<string, unknown>;
  const parameters = {
    memory: record.memory,
    passes: record.passes,
    parallelism: record.parallelism,
    tagLength: record.tagLength,
  };

  if (
    typeof parameters.memory !== "number" ||
    typeof parameters.passes !== "number" ||
    typeof parameters.parallelism !== "number" ||
    typeof parameters.tagLength !== "number"
  ) {
    throw new Error("Invalid password hash parameters in database");
  }

  return parameters as PasswordHashParameters;
}

function mapOwner(row: OwnerRow): OwnerCredentialRecord {
  if (row.password_algorithm !== "argon2id") {
    throw new Error("Unsupported password algorithm in database");
  }

  const password: StoredPasswordHash = {
    algorithm: "argon2id",
    salt: row.password_salt,
    hash: row.password_hash,
    parameters: parsePasswordParameters(row.password_parameters),
  };

  return {
    id: row.id,
    username: row.username,
    password,
    createdAt: row.created_at,
  };
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    tokenDigest: row.token_hash,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

const OWNER_COLUMNS = `
  id,
  username,
  password_algorithm,
  password_salt,
  password_hash,
  password_parameters,
  created_at
`;

export function createPostgresAuthRepository(pool: Pool): AuthRepository {
  return {
    async findOwner() {
      const result = await pool.query<OwnerRow>(
        `select ${OWNER_COLUMNS} from owner_accounts where singleton_key = 1 limit 1`,
      );
      const row = result.rows[0];
      return row ? mapOwner(row) : null;
    },

    async findOwnerByUsername(username) {
      const result = await pool.query<OwnerRow>(
        `select ${OWNER_COLUMNS} from owner_accounts where username = $1 limit 1`,
        [username],
      );
      const row = result.rows[0];
      return row ? mapOwner(row) : null;
    },

    async createOwner(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query<OwnerRow>(
          `insert into owner_accounts (
             id,
             singleton_key,
             username,
             password_algorithm,
             password_salt,
             password_hash,
             password_parameters,
             created_at
           ) values ($1, 1, $2, $3, $4, $5, $6::jsonb, $7)
           returning ${OWNER_COLUMNS}`,
          [
            input.id,
            input.username,
            input.password.algorithm,
            input.password.salt,
            input.password.hash,
            JSON.stringify(input.password.parameters),
            input.createdAt,
          ],
        );
        await client.query("commit");
        const row = result.rows[0];
        if (!row) throw new Error("Owner insert returned no row");
        return mapOwner(row);
      } catch (error) {
        await client.query("rollback");
        if (isUniqueViolation(error)) return null;
        throw error;
      } finally {
        client.release();
      }
    },

    async createSession(input) {
      const result = await pool.query<SessionRow>(
        `insert into auth_sessions (
           id,
           owner_id,
           token_hash,
           created_at,
           expires_at
         ) values ($1, $2, $3, $4, $5)
         returning id, owner_id, token_hash, expires_at, revoked_at`,
        [
          input.id,
          input.ownerId,
          input.tokenDigest,
          input.createdAt,
          input.expiresAt,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Session insert returned no row");
      return mapSession(row);
    },

    async findSessionByDigest(tokenDigest) {
      const result = await pool.query<SessionRow>(
        `select id, owner_id, token_hash, expires_at, revoked_at
           from auth_sessions
          where token_hash = $1
          limit 1`,
        [tokenDigest],
      );
      const row = result.rows[0];
      return row ? mapSession(row) : null;
    },

    async revokeSessionByDigest(tokenDigest, revokedAt) {
      await pool.query(
        `update auth_sessions
            set revoked_at = $2
          where token_hash = $1
            and revoked_at is null`,
        [tokenDigest, revokedAt],
      );
    },
  };
}
