import { createAuthService, createPasswordHasher } from "@uw/auth";
import { createArtifactService } from "@uw/artifacts";
import { createProjectService } from "@uw/core";
import { createDocumentService } from "@uw/documents";
import {
  checkDatabaseReady,
  createDatabasePool,
  createPostgresArtifactRepository,
  createPostgresAuditRepository,
  createPostgresAuthRepository,
  createPostgresDocumentRepository,
  createPostgresProjectRepository,
} from "@uw/database";
import { SystemClock, UuidGenerator } from "@uw/shared";
import { createLocalFilesystemStorage } from "@uw/storage";
import { createApp } from "./app.js";
import type { ServerConfig } from "./config.js";

export function composeApplication(config: ServerConfig) {
  const pool = createDatabasePool(config.databaseUrl);
  const clock = new SystemClock();
  const idGenerator = new UuidGenerator();
  const audit = createPostgresAuditRepository(pool);

  const authService = createAuthService({
    repository: createPostgresAuthRepository(pool),
    passwordHasher: createPasswordHasher(),
    clock,
    idGenerator,
    sessionTtlSeconds: config.sessionTtlSeconds,
  });

  const projectService = createProjectService({
    projects: createPostgresProjectRepository(pool),
    audit,
    clock,
    idGenerator,
  });

  const documentService = createDocumentService({
    documents: createPostgresDocumentRepository(pool),
    audit,
    clock,
    idGenerator,
  });

  const artifactService = createArtifactService({
    artifacts: createPostgresArtifactRepository(pool),
    storage: createLocalFilesystemStorage(config.artifactsDir),
    audit,
    clock,
    idGenerator,
  });

  const app = createApp({
    databaseReady: () => checkDatabaseReady(pool),
    authService,
    sessionCookie: {
      name: config.sessionCookieName,
      secure: config.sessionCookieSecure,
      maxAgeSeconds: config.sessionTtlSeconds,
    },
    projectService,
    documentService,
    artifactService,
  });

  return { app, pool };
}
