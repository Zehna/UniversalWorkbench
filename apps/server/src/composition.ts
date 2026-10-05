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
import { parseSecretRef, SystemClock, UuidGenerator } from "@uw/shared";
import { createWorkflowEngine, createExecutionWorker } from "@uw/execution";
import { createWorkflowService } from "@uw/workflow";
import {
  createAiTool,
  createToolRegistry,
  createTextTrimTool,
  createJsonExtractTool,
  createMarkdownToTextTool,
  createHttpTool,
  EgressPolicyError,
  type AiProviderPort,
  type EgressPolicy,
  type HttpTransport,
} from "@uw/tools";
import {
  createHttpProvider,
  createMockProvider,
  isMockAllowed,
  type AiProvider,
} from "@uw/providers";
import { createVaultStore } from "@uw/database";
import type { VaultStore } from "@uw/database";
import { resolveSecretResource } from "./secrets/resolve.js";
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

  const registry = composeToolRegistry(pool);
  const workflowPermissions =
    fixtureModeEnabled() || dockerSmokeFixtureEnabled()
      ? ["network", "ai"]
      : [];
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
    syncRepository,
    vaultPool: pool,
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

/**
 * Real-provider wiring. The HTTP provider is registered only when the
 * operator configured both a base URL and a credential reference; otherwise
 * AI runs fail closed with `AI_PROVIDER_NOT_CONFIGURED`. The credential
 * reference is a deployment gate only — per-request secrets always resolve
 * from the node's own `secretRef` at run time.
 */
function httpProviderOptionsFromEnv():
  | { id: string; baseUrl: string }
  | null {
  const baseUrl = process.env.AI_PROVIDER_BASE_URL;
  const secretRef = process.env.AI_PROVIDER_SECRET_REF;
  const id = process.env.AI_PROVIDER_ID ?? "http";
  if (!baseUrl || !secretRef || !id) return null;
  try {
    parseSecretRef(secretRef);
  } catch {
    return null;
  }
  return { id, baseUrl };
}

export function composeAiTool(pool: Parameters<typeof createVaultStore>[0]) {
  const vaultStore: VaultStore = createVaultStore(pool);
  const providers = new Map<string, AiProviderPort>();
  // The mock provider registers only behind the explicit test/fixture gate;
  // production composition never serves it, so `providerId: "mock"` fails
  // closed as an unknown provider there.
  if (isMockAllowed()) {
    const mock: AiProvider = createMockProvider();
    const port: AiProviderPort = mock;
    providers.set(port.id, port);
  }
  const httpOptions = httpProviderOptionsFromEnv();
  if (httpOptions) {
    const http: AiProvider = createHttpProvider(httpOptions);
    const port: AiProviderPort = http;
    providers.set(port.id, port);
  }
  return createAiTool({
    providers,
    resolveSecret: (ref: string, ownerId?: string) =>
      resolveSecretResource(ref, ownerId ?? "", vaultStore),
  });
}

export function composeToolRegistry(
  pool: Parameters<typeof createVaultStore>[0],
) {
  const registry = createToolRegistry();
  registry.register(createTextTrimTool());
  registry.register(createJsonExtractTool());
  registry.register(createMarkdownToTextTool());
  registry.register(
    fixtureModeEnabled() || dockerSmokeFixtureEnabled()
      ? createFixtureHttpTool()
      : createHttpTool(),
  );
  registry.register(composeAiTool(pool));
  return registry;
}

export function composeExecutionEngine(
  pool: ReturnType<typeof createDatabasePool>,
) {
  const registry = composeToolRegistry(pool);
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
