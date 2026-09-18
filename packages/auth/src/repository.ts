import type { StoredPasswordHash } from "./password.js";

export interface OwnerCredentialRecord {
  id: string;
  username: string;
  password: StoredPasswordHash;
  createdAt: Date;
}

export interface SessionRecord {
  id: string;
  ownerId: string;
  tokenDigest: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface CreateOwnerInput {
  id: string;
  username: string;
  password: StoredPasswordHash;
  createdAt: Date;
}

export interface CreateSessionInput {
  id: string;
  ownerId: string;
  tokenDigest: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface AuthRepository {
  findOwner(): Promise<OwnerCredentialRecord | null>;
  findOwnerByUsername(username: string): Promise<OwnerCredentialRecord | null>;
  createOwner(input: CreateOwnerInput): Promise<OwnerCredentialRecord | null>;
  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  findSessionByDigest(tokenDigest: string): Promise<SessionRecord | null>;
  revokeSessionByDigest(tokenDigest: string, revokedAt: Date): Promise<void>;
}
