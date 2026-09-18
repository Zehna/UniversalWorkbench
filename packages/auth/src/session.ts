import { createHash, randomBytes } from "node:crypto";

export interface SessionToken {
  raw: string;
  digest: string;
}

export function digestSessionToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function createSessionToken(): SessionToken {
  const raw = randomBytes(32).toString("base64url");

  return {
    raw,
    digest: digestSessionToken(raw),
  };
}
