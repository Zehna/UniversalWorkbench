import {
  NoteDocumentSchema,
  NoteDocumentViewSchema,
  OwnerPublicSchema,
  ProjectSchema,
  WorkflowDefinitionSchema,
  ToolDescriptorSchema,
  ExecutionStatusSchema,
  ContextEnvelopeSchema,
  ArtifactSchema,
  type ToolDescriptor,
  type WorkflowDefinition,
  type ContextEnvelope,
  type Artifact,
  type ExecutionStatus,
  type CreateNoteRequest,
  type CreateProjectRequest,
  type LoginRequest,
  type NoteDocument,
  type NoteDocumentView,
  type OwnerPublic,
  type Project,
  type SetupOwnerRequest,
  type UpdateNoteRequest,
} from "@uw/contracts";

export interface WorkflowVersion {
  id: string;
  workflowId: string;
  version: number;
  ownerId: string;
  projectId: string;
  definition: WorkflowDefinition;
  createdAt: string;
}

export interface ToolCatalogResponse {
  tools: ToolDescriptor[];
  grantedPermissions: string[];
}

export interface ExecutionDetails {
  execution: {
    id: string;
    status: ExecutionStatus;
    projectId: string;
    traceId: string;
    error: { code: string; message: string } | null;
    usage: Record<string, unknown>;
    startedAt: string | null;
    finishedAt: string | null;
  };
  steps: Array<{
    nodeId: string;
    toolId: string;
    toolVersion: string;
    attempt: number;
    status: ExecutionStatus;
    outputContexts: ContextEnvelope[];
    error: { code: string; message: string } | null;
  }>;
  receipt: Record<string, unknown> | null;
}

function workflowVersion(value: unknown): WorkflowVersion {
  const item = record(value);
  if (
    typeof item.id !== "string" ||
    typeof item.workflowId !== "string" ||
    typeof item.version !== "number" ||
    typeof item.ownerId !== "string" ||
    typeof item.projectId !== "string" ||
    typeof item.createdAt !== "string"
  )
    throw new Error("Invalid workflow response");
  return {
    id: item.id,
    workflowId: item.workflowId,
    version: item.version,
    ownerId: item.ownerId,
    projectId: item.projectId,
    createdAt: item.createdAt,
    definition: WorkflowDefinitionSchema.parse(item.definition),
  };
}

function executionDetails(value: unknown): ExecutionDetails {
  const data = record(value);
  const execution = record(data.execution);
  if (
    typeof execution.id !== "string" ||
    typeof execution.projectId !== "string" ||
    typeof execution.traceId !== "string" ||
    !Array.isArray(data.steps)
  )
    throw new Error("Invalid execution response");
  const parsedSteps = data.steps.map((item: unknown) => {
    const step = record(item);
    if (
      typeof step.nodeId !== "string" ||
      typeof step.toolId !== "string" ||
      typeof step.toolVersion !== "string" ||
      typeof step.attempt !== "number" ||
      !Array.isArray(step.outputContexts)
    )
      throw new Error("Invalid execution step");
    const error = step.error;
    return {
      nodeId: step.nodeId,
      toolId: step.toolId,
      toolVersion: step.toolVersion,
      attempt: step.attempt,
      status: ExecutionStatusSchema.parse(step.status),
      outputContexts: step.outputContexts.map((value: unknown) =>
        ContextEnvelopeSchema.parse(value),
      ),
      error:
        error === null
          ? null
          : typeof record(error).code === "string" &&
              typeof record(error).message === "string"
            ? {
                code: String(record(error).code),
                message: String(record(error).message),
              }
            : null,
    };
  });
  const err = execution.error;
  return {
    execution: {
      id: execution.id,
      projectId: execution.projectId,
      traceId: execution.traceId,
      status: ExecutionStatusSchema.parse(execution.status),
      error:
        err === null
          ? null
          : typeof record(err).code === "string" &&
              typeof record(err).message === "string"
            ? {
                code: String(record(err).code),
                message: String(record(err).message),
              }
            : null,
      usage: record(execution.usage),
      startedAt:
        typeof execution.startedAt === "string" ? execution.startedAt : null,
      finishedAt:
        typeof execution.finishedAt === "string" ? execution.finishedAt : null,
    },
    steps: parsedSteps,
    receipt: data.receipt === null ? null : record(data.receipt),
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;

  const text = await response.text();
  if (text.length === 0) return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function apiError(response: Response, body: unknown): ApiError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : {};
  const code = typeof error.code === "string" ? error.code : "REQUEST_FAILED";
  const message =
    typeof error.message === "string" ? error.message : "Request failed";
  const details = Object.fromEntries(
    Object.entries(error).filter(
      ([key]) => key !== "code" && key !== "message",
    ),
  );
  return new ApiError(response.status, code, message, details);
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");

  const response = await fetch(`/api${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
  const body = await parseBody(response);
  if (!response.ok) throw apiError(response, body);
  return body;
}

function record(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new Error("Invalid API response");
  return body;
}

export const api = {
  async setupStatus(): Promise<boolean> {
    const body = record(await request("/setup/status"));
    if (typeof body.initialized !== "boolean")
      throw new Error("Invalid setup status response");
    return body.initialized;
  },

  async setupOwner(input: SetupOwnerRequest): Promise<OwnerPublic> {
    const body = record(
      await request("/setup/owner", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
    return OwnerPublicSchema.parse(body.owner);
  },

  async session(): Promise<OwnerPublic> {
    const body = record(await request("/auth/session"));
    return OwnerPublicSchema.parse(body.owner);
  },

  async login(input: LoginRequest): Promise<OwnerPublic> {
    const body = record(
      await request("/auth/login", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
    return OwnerPublicSchema.parse(body.owner);
  },

  async listProjects(): Promise<Project[]> {
    const body = record(await request("/projects"));
    if (!Array.isArray(body.projects))
      throw new Error("Invalid project list response");
    return body.projects.map((project) => ProjectSchema.parse(project));
  },

  async createProject(input: CreateProjectRequest): Promise<Project> {
    const body = record(
      await request("/projects", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
    return ProjectSchema.parse(body.project);
  },

  async listDocuments(projectId: string): Promise<NoteDocument[]> {
    const body = record(await request(`/projects/${projectId}/documents`));
    if (!Array.isArray(body.documents))
      throw new Error("Invalid document list response");
    return body.documents.map((document) => NoteDocumentSchema.parse(document));
  },

  async getDocument(
    projectId: string,
    documentId: string,
  ): Promise<NoteDocumentView> {
    return NoteDocumentViewSchema.parse(
      await request(`/projects/${projectId}/documents/${documentId}`),
    );
  },

  async createNote(
    projectId: string,
    input: CreateNoteRequest,
  ): Promise<NoteDocumentView> {
    return NoteDocumentViewSchema.parse(
      await request(`/projects/${projectId}/documents`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  },

  async updateNote(
    projectId: string,
    documentId: string,
    input: UpdateNoteRequest,
  ): Promise<NoteDocumentView> {
    return NoteDocumentViewSchema.parse(
      await request(`/projects/${projectId}/documents/${documentId}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    );
  },

  async listTools(): Promise<ToolCatalogResponse> {
    const body = record(await request("/tools"));
    if (!Array.isArray(body.tools)) throw new Error("Invalid tool catalog");
    return {
      tools: body.tools.map((value) => ToolDescriptorSchema.parse(value)),
      grantedPermissions: Array.isArray(body.grantedPermissions)
        ? body.grantedPermissions.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
    };
  },

  async listWorkflows(projectId: string): Promise<WorkflowVersion[]> {
    const body = record(await request(`/projects/${projectId}/workflows`));
    if (!Array.isArray(body.workflows))
      throw new Error("Invalid workflow list");
    return body.workflows.map(workflowVersion);
  },

  async getWorkflow(
    projectId: string,
    workflowId: string,
  ): Promise<WorkflowVersion> {
    const body = record(
      await request(`/projects/${projectId}/workflows/${workflowId}`),
    );
    return workflowVersion(body.workflow);
  },

  async saveWorkflow(
    projectId: string,
    definition: WorkflowDefinition,
    expectedVersion?: number,
  ): Promise<WorkflowVersion> {
    const body = record(
      await request(`/projects/${projectId}/workflows`, {
        method: "POST",
        body: JSON.stringify({
          definition,
          ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        }),
      }),
    );
    return workflowVersion(body.workflow);
  },

  async runWorkflow(
    projectId: string,
    workflowId: string,
    input: ContextEnvelope,
  ): Promise<{
    executionId: string;
    status: ExecutionStatus;
    traceId: string;
  }> {
    const body = record(
      await request(
        `/projects/${projectId}/workflows/${workflowId}/executions`,
        {
          method: "POST",
          body: JSON.stringify({ input }),
        },
      ),
    );
    if (
      typeof body.executionId !== "string" ||
      typeof body.traceId !== "string"
    )
      throw new Error("Invalid queued execution");
    return {
      executionId: body.executionId,
      traceId: body.traceId,
      status: ExecutionStatusSchema.parse(body.status),
    };
  },

  async getExecution(
    projectId: string,
    executionId: string,
  ): Promise<ExecutionDetails> {
    return executionDetails(
      await request(`/projects/${projectId}/executions/${executionId}`),
    );
  },

  async cancelExecution(
    projectId: string,
    executionId: string,
  ): Promise<ExecutionDetails> {
    return executionDetails(
      await request(`/projects/${projectId}/executions/${executionId}/cancel`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
  },

  async saveExecutionOutput(
    projectId: string,
    executionId: string,
    outputContextId: string,
  ): Promise<Artifact> {
    const body = record(
      await request(`/projects/${projectId}/artifacts/from-execution`, {
        method: "POST",
        body: JSON.stringify({ executionId, outputContextId }),
      }),
    );
    return ArtifactSchema.parse(body.artifact);
  },

  async saveNoteFromExecution(
    projectId: string,
    executionId: string,
    outputContextId: string,
  ): Promise<NoteDocumentView> {
    const body = record(
      await request(`/projects/${projectId}/documents/from-execution`, {
        method: "POST",
        body: JSON.stringify({ executionId, outputContextId }),
      }),
    );
    return NoteDocumentViewSchema.parse(record(body).document);
  },
};
