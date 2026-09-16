import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

export interface PasswordHashParameters {
  memory: number;
  passes: number;
  parallelism: number;
  tagLength: number;
}

export interface StoredPasswordHash {
  algorithm: "argon2id";
  salt: string;
  hash: string;
  parameters: PasswordHashParameters;
}

export interface PasswordHasher {
  hash(password: string): Promise<StoredPasswordHash>;
  verify(password: string, stored: StoredPasswordHash): Promise<boolean>;
}

const PASSWORD_PARAMETERS: Readonly<PasswordHashParameters> = Object.freeze({
  memory: 19 * 1024,
  passes: 2,
  parallelism: 1,
  tagLength: 32,
});

const SALT_BYTES = 16;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function hasExpectedParameters(parameters: PasswordHashParameters): boolean {
  return (
    parameters.memory === PASSWORD_PARAMETERS.memory &&
    parameters.passes === PASSWORD_PARAMETERS.passes &&
    parameters.parallelism === PASSWORD_PARAMETERS.parallelism &&
    parameters.tagLength === PASSWORD_PARAMETERS.tagLength
  );
}

function decodeBase64Url(value: string, expectedBytes: number): Buffer | null {
  if (!BASE64URL_PATTERN.test(value)) return null;

  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === expectedBytes ? decoded : null;
}

function deriveArgon2id(
  password: string,
  salt: Buffer,
  parameters: PasswordHashParameters,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      "argon2id",
      {
        message: Buffer.from(password, "utf8"),
        nonce: salt,
        parallelism: parameters.parallelism,
        tagLength: parameters.tagLength,
        memory: parameters.memory,
        passes: parameters.passes,
      },
      (error, derivedKey) => {
        if (error) {
          reject(new Error("Password hashing failed", { cause: error }));
          return;
        }

        resolve(Buffer.from(derivedKey));
      },
    );
  });
}

export function createPasswordHasher(): PasswordHasher {
  return {
    async hash(password: string): Promise<StoredPasswordHash> {
      const salt = randomBytes(SALT_BYTES);
      const parameters = { ...PASSWORD_PARAMETERS };
      const derivedKey = await deriveArgon2id(password, salt, parameters);

      return {
        algorithm: "argon2id",
        salt: salt.toString("base64url"),
        hash: derivedKey.toString("base64url"),
        parameters,
      };
    },

    async verify(password: string, stored: StoredPasswordHash): Promise<boolean> {
      if (stored.algorithm !== "argon2id") return false;
      if (!hasExpectedParameters(stored.parameters)) return false;

      const salt = decodeBase64Url(stored.salt, SALT_BYTES);
      const expected = decodeBase64Url(stored.hash, stored.parameters.tagLength);
      if (!salt || !expected) return false;

      try {
        const actual = await deriveArgon2id(password, salt, stored.parameters);
        return (
          actual.byteLength === expected.byteLength &&
          timingSafeEqual(actual, expected)
        );
      } catch {
        return false;
      }
    },
  };
}
