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
  createPostgresExecutionQueue,
  createPostgresProjectRepository,
  createPostgresSyncDocumentStore,
  createPostgresSyncProjectStore,
  createPostgresSyncRepository,
} from "@uw/database";
import { SystemClock, UuidGenerator } from "@uw/shared";
import { createExecutionWorker } from "@uw/execution";
import { randomUUID } from "node:crypto";
import { createSyncOperationApplier, createSyncService } from "@uw/sync";
import { createLocalFilesystemStorage } from "@uw/storage";
import { createApp } from "./app.js";
import type { ServerConfig } from "./config.js";

export function composeApplication(
  config: ServerConfig,
  pool = createDatabasePool(config.databaseUrl),
) {
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

  const syncRepository = createPostgresSyncRepository(pool);
  const syncService = createSyncService({
    repository: syncRepository,
    applier: createSyncOperationApplier({
      repository: syncRepository,
      projects: createPostgresSyncProjectStore(pool),
      documents: createPostgresSyncDocumentStore(pool),
      audit,
      clock,
      idGenerator,
    }),
    clock,
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
    syncService,
  });

  return { app, pool, authService, syncService };
}

/**
 * The Task 8 engine is not installed yet. Pending jobs are released for retry,
 * never ACKed or marked completed by this placeholder processor.
 */
export function composeWorker(
  config: ServerConfig,
  pool: ReturnType<typeof createDatabasePool>,
) {
  return createExecutionWorker({
    queue: createPostgresExecutionQueue(pool),
    workerId: randomUUID(),
    pollIntervalMs: config.workerPollMs,
    leaseMs: config.workerLeaseMs,
    retryDelayMs: config.workerRetryMs,
    processor: async () => {
      throw new Error("Workflow execution engine is not yet configured");
    },
    onError: () => {
      console.warn(
        "Execution worker could not process an item; released for retry",
      );
    },
  });
}
