import type { StoredPasswordHash } from "./password.js";

export interface OwnerCredentialRecord {
  id: string;
  username: string;
  password: StoredPasswordHash;
}

export interface SessionRecord {
  id: string;
  ownerId: string;
  tokenDigest: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface AuthRepository {
  findOwner(): Promise<OwnerCredentialRecord | null>;
  findOwnerByUsername(username: string): Promise<OwnerCredentialRecord | null>;
  findSessionByDigest(tokenDigest: string): Promise<SessionRecord | null>;
}
