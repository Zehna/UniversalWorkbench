import type { WorkflowDefinition } from "@uw/contracts";

export interface WorkflowVersion {
  id: string;
  workflowId: string;
  version: number;
  ownerId: string;
  projectId: string;
  definition: WorkflowDefinition;
  createdAt: Date;
}

export interface WorkflowRepository {
  list(ownerId: string, projectId: string): Promise<WorkflowVersion[]>;
  get(
    ownerId: string,
    projectId: string,
    workflowId: string,
  ): Promise<WorkflowVersion | null>;
  save(
    ownerId: string,
    projectId: string,
    definition: WorkflowDefinition,
    expectedVersion?: number,
  ): Promise<WorkflowVersion>;
}

export class WorkflowNotFoundError extends Error {
  constructor() {
    super("Workflow or project was not found");
    this.name = "WorkflowNotFoundError";
  }
}

export class WorkflowVersionConflictError extends Error {
  constructor() {
    super("Workflow has changed; provide its latest version");
    this.name = "WorkflowVersionConflictError";
  }
}
