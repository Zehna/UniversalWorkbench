import {
  NoteDocumentSchema,
  NoteDocumentViewSchema,
  OwnerPublicSchema,
  ProjectSchema,
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
};
