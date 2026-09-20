import { createAuthService, createPasswordHasher } from "@uw/auth";
import { createArtifactService } from "@uw/artifacts";
import type { ToolCapability } from "@uw/contracts";
import { createProjectService } from "@uw/core";
import {
  createDocumentService,
  createExecutionNoteWriter,
} from "@uw/documents";
import {
  checkDatabaseReady,
  closeDatabasePool,
  createDatabasePool,
  createPostgresArtifactRepository,
  createPostgresAuditRepository,
  createPostgresAuthRepository,
  createPostgresDocumentRepository,
  createPostgresExecutionOutputRepository,
  createPostgresExecutionQueue,
  createPostgresExecutionReceiptRepository,
  createPostgresExecutionRepository,
  createPostgresExecutionStepRepository,
  createPostgresPinnedWorkflowRevisionLoader,
  createPostgresProjectRepository,
  createPostgresProvenanceRepository,
  createPostgresSyncDocumentStore,
  createPostgresSyncProjectStore,
  createPostgresSyncRepository,
  listPostgresExecutionsByProject,
} from "@uw/database";
import {
  DEFAULT_EXECUTION_BUDGET,
  createDirectToolExecutionService,
  createExecutionEngine,
  createExecutionService,
  createExecutionWorker,
} from "@uw/execution";
import { SystemClock, UuidGenerator } from "@uw/shared";
import { createSyncOperationApplier, createSyncService } from "@uw/sync";
import { createLocalFilesystemStorage } from "@uw/storage";
import {
  HTTP_REQUEST_TOOL_DEFINITION,
  JSON_PARSE_TOOL_DEFINITION,
  JSON_SELECT_TOOL_DEFINITION,
  NOTE_WRITE_TOOL_DEFINITION,
  TEXT_TEMPLATE_TOOL_DEFINITION,
  ToolRegistry,
  createHttpRequestTool,
  createJsonParseTool,
  createJsonSelectTool,
  createNoteWriteTool,
  createTextTemplateTool,
} from "@uw/tools";
import {
  WorkflowPreflightError,
  createWorkflowExecutionLifecycle,
  createWorkflowService,
  validateWorkflowDefinition,
} from "@uw/workflow";
import { createApp } from "./app.js";
import type { ServerConfig } from "./config.js";
import type { ExecutionApiService } from "./routes/executions.js";
import { createExecutionRuntimeLoader } from "./worker-runtime.js";

const OWNER_CAPABILITIES: ToolCapability[] = [
  "network.public",
  "project.documents.read",
  "project.documents.write",
  "project.artifacts.read",
  "project.artifacts.write",
];

export function composeApplication(config: ServerConfig) {
  const pool = createDatabasePool(config.databaseUrl);
  const clock = new SystemClock();
  const idGenerator = new UuidGenerator();
  const audit = createPostgresAuditRepository(pool);
  const documentRepository = createPostgresDocumentRepository(pool);
  const artifactRepository = createPostgresArtifactRepository(pool);

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

  const artifactService = createArtifactService({
    artifacts: artifactRepository,
    storage: createLocalFilesystemStorage(config.artifactsDir),
    audit,
    clock,
    idGenerator,
  });

  const executionNoteWriter = createExecutionNoteWriter({
    documents: documentRepository,
    audit,
    clock,
    idGenerator,
  });

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(
    HTTP_REQUEST_TOOL_DEFINITION,
    createHttpRequestTool({
      artifacts: artifactService,
      contextIds: idGenerator,
    }),
  );
  toolRegistry.register(
    JSON_PARSE_TOOL_DEFINITION,
    createJsonParseTool({
      artifacts: artifactService,
      contextIds: idGenerator,
    }),
  );
  toolRegistry.register(
    JSON_SELECT_TOOL_DEFINITION,
    createJsonSelectTool({ contextIds: idGenerator }),
  );
  toolRegistry.register(
    TEXT_TEMPLATE_TOOL_DEFINITION,
    createTextTemplateTool({ contextIds: idGenerator }),
  );
  toolRegistry.register(
    NOTE_WRITE_TOOL_DEFINITION,
    createNoteWriteTool({
      documents: executionNoteWriter,
      contextIds: idGenerator,
    }),
  );

  const documentService = createDocumentService({
    documents: documentRepository,
    audit,
    clock,
    idGenerator,
    validateWorkflow(definition) {
      const result = validateWorkflowDefinition(
        definition,
        toolRegistry,
        OWNER_CAPABILITIES,
        DEFAULT_EXECUTION_BUDGET,
      );
      if (!result.ok) throw new WorkflowPreflightError(result.errors);
    },
  });

  const executionRepository = createPostgresExecutionRepository(pool);
  const stepRepository = createPostgresExecutionStepRepository(pool);
  const receiptRepository = createPostgresExecutionReceiptRepository(pool);
  const provenanceRepository = createPostgresProvenanceRepository(pool);
  const outputRepository = createPostgresExecutionOutputRepository(pool);
  const executionQueue = createPostgresExecutionQueue(pool);
  const pinnedWorkflows = createPostgresPinnedWorkflowRevisionLoader(pool);

  const executionService = createExecutionService({
    executions: executionRepository,
    receipts: receiptRepository,
    provenance: provenanceRepository,
    clock,
    idGenerator,
  });

  const executionApiService: ExecutionApiService = {
    ...executionService,
    list(ownerId, projectId) {
      return listPostgresExecutionsByProject(pool, ownerId, projectId);
    },
  };

  const workflowService = createWorkflowService({
    canonical: documentService,
    executions: executionService,
    steps: stepRepository,
    queue: executionQueue,
    tools: toolRegistry,
    allowedCapabilities: OWNER_CAPABILITIES,
    clock,
    idGenerator,
  });

  const workflowLifecycle = createWorkflowExecutionLifecycle({
    workflows: pinnedWorkflows,
    executions: executionRepository,
    steps: stepRepository,
    outputs: outputRepository,
    queue: executionQueue,
    provenance: provenanceRepository,
    clock,
    edgeIds: idGenerator,
  });

  const engine = createExecutionEngine({
    executions: executionRepository,
    steps: stepRepository,
    receipts: receiptRepository,
    outputs: outputRepository,
    queue: executionQueue,
    tools: toolRegistry,
    runtime: createExecutionRuntimeLoader({
      workflows: pinnedWorkflows,
      steps: stepRepository,
      outputs: outputRepository,
    }),
    lifecycle: workflowLifecycle,
    clock,
    idGenerator,
  });

  const worker = createExecutionWorker({
    workerId: `worker-${idGenerator.next()}`,
    queue: executionQueue,
    engine,
    clock,
    leaseMs: 30_000,
    pollIntervalMs: 250,
  });

  const directToolExecutionService = createDirectToolExecutionService({
    executions: executionService,
    steps: stepRepository,
    queue: executionQueue,
    tools: toolRegistry,
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
    toolRegistry,
    workflowService,
    executionService: executionApiService,
    directToolExecutionService,
  });

  return {
    app,
    authService,
    syncService,
    worker,
    async close() {
      await closeDatabasePool(pool);
    },
  };
}
