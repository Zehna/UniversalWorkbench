import type {
  CreateProjectRequest,
  Project,
  UpdateProjectRequest,
} from "@uw/contracts";
import type { Clock, IdGenerator } from "@uw/shared";
import { executeAction } from "./action.js";

export interface CreateProjectRecordInput {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpdateProjectRecordInput {
  name?: string;
  description?: string | null;
  updatedAt: Date;
}

export interface ProjectRepository {
  create(input: CreateProjectRecordInput): Promise<Project>;
  list(ownerId: string): Promise<Project[]>;
  get(ownerId: string, projectId: string): Promise<Project | null>;
  update(
    ownerId: string,
    projectId: string,
    input: UpdateProjectRecordInput,
  ): Promise<Project | null>;
  remove(ownerId: string, projectId: string): Promise<boolean>;
}

export interface AuditRecordInput {
  id: string;
  actorId: string;
  projectId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  traceId: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface AuditRepository {
  record(input: AuditRecordInput): Promise<void>;
}

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project not found: ${projectId}`);
    this.name = "ProjectNotFoundError";
  }
}

export interface ProjectService {
  create(
    ownerId: string,
    input: CreateProjectRequest,
    traceId: string,
  ): Promise<Project>;
  list(ownerId: string): Promise<Project[]>;
  get(ownerId: string, projectId: string): Promise<Project>;
  update(
    ownerId: string,
    projectId: string,
    input: UpdateProjectRequest,
    traceId: string,
  ): Promise<Project>;
  delete(ownerId: string, projectId: string, traceId: string): Promise<void>;
}

export interface CreateProjectServiceOptions {
  projects: ProjectRepository;
  audit: AuditRepository;
  clock: Clock;
  idGenerator: IdGenerator;
}

function changedFields(
  input: CreateProjectRequest | UpdateProjectRequest,
): string[] {
  return Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
    .sort();
}

export function createProjectService(
  options: CreateProjectServiceOptions,
): ProjectService {
  const { projects, audit, clock, idGenerator } = options;

  return {
    async create(ownerId, input, traceId) {
      return executeAction({
        name: "project.create",
        input,
        context: { actorId: ownerId, traceId },
        authorize: async () => undefined,
        run: async () => {
          const now = clock.now();
          return projects.create({
            id: idGenerator.next(),
            ownerId,
            name: input.name,
            description: input.description ?? null,
            createdAt: now,
            updatedAt: now,
          });
        },
        audit: async (project) => {
          await audit.record({
            id: idGenerator.next(),
            actorId: ownerId,
            projectId: project.id,
            action: "project.create",
            targetType: "project",
            targetId: project.id,
            traceId,
            metadata: { fields: changedFields(input) },
            createdAt: clock.now(),
          });
        },
      });
    },

    async list(ownerId) {
      return projects.list(ownerId);
    },

    async get(ownerId, projectId) {
      const project = await projects.get(ownerId, projectId);
      if (!project) throw new ProjectNotFoundError(projectId);
      return project;
    },

    async update(ownerId, projectId, input, traceId) {
      return executeAction({
        name: "project.update",
        input,
        context: { actorId: ownerId, traceId, projectId },
        authorize: async () => {
          if (!(await projects.get(ownerId, projectId))) {
            throw new ProjectNotFoundError(projectId);
          }
        },
        run: async () => {
          const project = await projects.update(ownerId, projectId, {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
            updatedAt: clock.now(),
          });
          if (!project) throw new ProjectNotFoundError(projectId);
          return project;
        },
        audit: async (project) => {
          await audit.record({
            id: idGenerator.next(),
            actorId: ownerId,
            projectId: project.id,
            action: "project.update",
            targetType: "project",
            targetId: project.id,
            traceId,
            metadata: { fields: changedFields(input) },
            createdAt: clock.now(),
          });
        },
      });
    },

    async delete(ownerId, projectId, traceId) {
      return executeAction({
        name: "project.delete",
        input: { projectId },
        context: { actorId: ownerId, traceId, projectId },
        authorize: async () => {
          if (!(await projects.get(ownerId, projectId))) {
            throw new ProjectNotFoundError(projectId);
          }
        },
        run: async () => {
          const removed = await projects.remove(ownerId, projectId);
          if (!removed) throw new ProjectNotFoundError(projectId);
        },
        audit: async () => {
          await audit.record({
            id: idGenerator.next(),
            actorId: ownerId,
            projectId,
            action: "project.delete",
            targetType: "project",
            targetId: projectId,
            traceId,
            metadata: {},
            createdAt: clock.now(),
          });
        },
      });
    },
  };
}
