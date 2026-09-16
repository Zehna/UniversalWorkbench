import { createAuthService, createPasswordHasher } from "@uw/auth";
import {
  checkDatabaseReady,
  createDatabasePool,
  createPostgresAuthRepository,
} from "@uw/database";
import { SystemClock, UuidGenerator } from "@uw/shared";
import { createApp } from "./app.js";
import type { ServerConfig } from "./config.js";

export function composeApplication(config: ServerConfig) {
  const pool = createDatabasePool(config.databaseUrl);
  const authService = createAuthService({
    repository: createPostgresAuthRepository(pool),
    passwordHasher: createPasswordHasher(),
    clock: new SystemClock(),
    idGenerator: new UuidGenerator(),
    sessionTtlSeconds: config.sessionTtlSeconds,
  });

  const app = createApp({
    databaseReady: () => checkDatabaseReady(pool),
    authService,
    sessionCookie: {
      name: config.sessionCookieName,
      secure: config.sessionCookieSecure,
      maxAgeSeconds: config.sessionTtlSeconds,
    },
  });

  return { app, pool };
}
