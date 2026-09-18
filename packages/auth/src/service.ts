import type {
  LoginRequest,
  OwnerPublic,
  SetupOwnerRequest,
} from "@uw/contracts";
import type { Clock, IdGenerator } from "@uw/shared";
import type { PasswordHasher } from "./password.js";
import type { AuthRepository, OwnerCredentialRecord } from "./repository.js";
import {
  createSessionToken,
  digestSessionToken,
  type SessionToken,
} from "./session.js";

export class AuthAlreadyInitializedError extends Error {
  constructor() {
    super("Owner account is already initialized");
    this.name = "AuthAlreadyInitializedError";
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid credentials");
    this.name = "InvalidCredentialsError";
  }
}

export interface AuthService {
  isInitialized(): Promise<boolean>;
  setupOwner(
    input: SetupOwnerRequest,
  ): Promise<{ owner: OwnerPublic; session: SessionToken }>;
  login(
    input: LoginRequest,
  ): Promise<{ owner: OwnerPublic; session: SessionToken }>;
  resolveSession(rawToken: string): Promise<OwnerPublic | null>;
  logout(rawToken: string): Promise<void>;
}

export interface CreateAuthServiceOptions {
  repository: AuthRepository;
  passwordHasher: PasswordHasher;
  clock: Clock;
  idGenerator: IdGenerator;
  sessionTtlSeconds: number;
}

function toOwnerPublic(owner: OwnerCredentialRecord): OwnerPublic {
  return {
    id: owner.id,
    username: owner.username,
    createdAt: owner.createdAt.toISOString(),
  };
}

export function createAuthService(
  options: CreateAuthServiceOptions,
): AuthService {
  const { repository, passwordHasher, clock, idGenerator, sessionTtlSeconds } =
    options;

  if (!Number.isInteger(sessionTtlSeconds) || sessionTtlSeconds <= 0) {
    throw new Error("sessionTtlSeconds must be a positive integer");
  }

  async function createSession(ownerId: string): Promise<SessionToken> {
    const now = clock.now();
    const token = createSessionToken();
    const expiresAt = new Date(now.getTime() + sessionTtlSeconds * 1000);

    await repository.createSession({
      id: idGenerator.next(),
      ownerId,
      tokenDigest: token.digest,
      createdAt: now,
      expiresAt,
    });

    return token;
  }

  return {
    async isInitialized(): Promise<boolean> {
      return (await repository.findOwner()) !== null;
    },

    async setupOwner(input) {
      if (await repository.findOwner()) {
        throw new AuthAlreadyInitializedError();
      }

      const password = await passwordHasher.hash(input.password);
      const owner = await repository.createOwner({
        id: idGenerator.next(),
        username: input.username,
        password,
        createdAt: clock.now(),
      });

      if (!owner) {
        throw new AuthAlreadyInitializedError();
      }

      const session = await createSession(owner.id);
      return { owner: toOwnerPublic(owner), session };
    },

    async login(input) {
      const owner = await repository.findOwnerByUsername(input.username);
      if (
        !owner ||
        !(await passwordHasher.verify(input.password, owner.password))
      ) {
        throw new InvalidCredentialsError();
      }

      const session = await createSession(owner.id);
      return { owner: toOwnerPublic(owner), session };
    },

    async resolveSession(rawToken) {
      if (!rawToken) return null;

      const session = await repository.findSessionByDigest(
        digestSessionToken(rawToken),
      );
      if (!session || session.revokedAt) return null;
      if (session.expiresAt.getTime() <= clock.now().getTime()) return null;

      const owner = await repository.findOwner();
      if (!owner || owner.id !== session.ownerId) return null;

      return toOwnerPublic(owner);
    },

    async logout(rawToken) {
      if (!rawToken) return;
      await repository.revokeSessionByDigest(
        digestSessionToken(rawToken),
        clock.now(),
      );
    },
  };
}
