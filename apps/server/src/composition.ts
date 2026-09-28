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
  createPostgresWorkflowExecutionStore,
  createPostgresWorkflowRepository,
  createPostgresProjectRepository,
  createPostgresSyncDocumentStore,
  createPostgresSyncProjectStore,
  createPostgresSyncRepository,
} from "@uw/database";
import { SystemClock, UuidGenerator } from "@uw/shared";
import { createWorkflowEngine, createExecutionWorker } from "@uw/execution";
import { createWorkflowService } from "@uw/workflow";
import {
  createToolRegistry,
  createTextTrimTool,
  createJsonExtractTool,
  createMarkdownToTextTool,
  createHttpTool,
  EgressPolicyError,
  type EgressPolicy,
  type HttpTransport,
} from "@uw/tools";
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

  const registry = composeToolRegistry();
  const workflowPermissions =
    fixtureModeEnabled() || dockerSmokeFixtureEnabled() ? ["network"] : [];
  const executionStore = createPostgresWorkflowExecutionStore(pool);
  const engine = createWorkflowEngine({ store: executionStore, registry });
  const workflowService = createWorkflowService({
    repository: createPostgresWorkflowRepository(pool),
    registry,
    enqueue: (input) => engine.enqueue(input),
    // Grants originate from server policy, not caller-provided JSON.
    allowedPermissions: workflowPermissions,
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
    workflowService,
    toolRegistry: registry,
    grantedWorkflowPermissions: workflowPermissions,
    executionRepository: executionStore,
  });

  return { app, pool, authService, syncService };
}

/** Create the same pinned registry for API validation and worker execution. */
function fixtureModeEnabled(): boolean {
  return (
    process.env.WORKBENCH_E2E_FIXTURE === "1" &&
    process.env.NODE_ENV === "test" &&
    typeof process.env.TEST_DATABASE_URL === "string"
  );
}

/**
 * Docker smoke-only fixture. The injected transport serves one deterministic
 * HTTPS fixture URL with no external network traffic and no egress bypass.
 * Default-off; never enable in production deployments.
 */
function dockerSmokeFixtureEnabled(): boolean {
  return process.env.WORKBENCH_DOCKER_SMOKE_FIXTURE === "1";
}

/**
 * E2E and Docker-smoke-only transport. No external connections are made; only
 * the exact deterministic HTTPS fixture URL is accepted. Disabled outside
 * test mode and the explicit Docker smoke fixture flag.
 */
function createFixtureHttpTool() {
  const fixtureUrl = "https://fixture.workbench.dev/response";
  const assertAllowed = (url: URL) => {
    if (url.href !== fixtureUrl) {
      throw new EgressPolicyError(
        "EGRESS_BLOCKED",
        "E2E fixture destination not permitted",
      );
    }
  };
  const policy: EgressPolicy = {
    async assertAllowed(url) {
      assertAllowed(url);
    },
    async resolveAllowed(url) {
      assertAllowed(url);
      return ["8.8.8.8"];
    },
  };
  const transport: HttpTransport = {
    async request(url, _address, options) {
      assertAllowed(url);
      if (options.method !== "GET") {
        throw new EgressPolicyError(
          "EGRESS_BLOCKED",
          "E2E fixture accepts GET only",
        );
      }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(
          '{"answer":42,"source":"workbench-e2e"}',
        ),
      };
    },
  };
  return createHttpTool({ policy, transport });
}

export function composeToolRegistry() {
  const registry = createToolRegistry();
  registry.register(createTextTrimTool());
  registry.register(createJsonExtractTool());
  registry.register(createMarkdownToTextTool());
  registry.register(
    fixtureModeEnabled() || dockerSmokeFixtureEnabled()
      ? createFixtureHttpTool()
      : createHttpTool(),
  );
  return registry;
}

export function composeExecutionEngine(
  pool: ReturnType<typeof createDatabasePool>,
) {
  const registry = composeToolRegistry();
  return createWorkflowEngine({
    store: createPostgresWorkflowExecutionStore(pool),
    registry,
  });
}

export function composeWorker(
  config: ServerConfig,
  pool: ReturnType<typeof createDatabasePool>,
) {
  const engine = composeExecutionEngine(pool);
  return createExecutionWorker({
    queue: createPostgresExecutionQueue(pool),
    workerId: randomUUID(),
    pollIntervalMs: config.workerPollMs,
    leaseMs: config.workerLeaseMs,
    retryDelayMs: config.workerRetryMs,
    processor: async (executionId, signal) => {
      await engine.process(executionId, signal);
    },
    onError: () => {
      console.warn(
        "Execution worker encountered a retriable infrastructure error",
      );
    },
  });
}
