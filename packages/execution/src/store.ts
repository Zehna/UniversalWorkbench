import type { ContextEnvelope, WorkflowDefinition } from "@uw/contracts";
import type {
  CreateExecutionRecord,
  ExecutionRecord,
  ExecutionStepRecord,
  ExecutionView,
  StructuredExecutionError,
} from "./model.js";
import type { ExecutionBudget } from "./budget.js";
import type { ExecutionRepository } from "./repository.js";

export interface ExecutionSubmission extends CreateExecutionRecord {
  workflow: WorkflowDefinition;
  workflowVersion: number;
  grantedPermissions: string[];
  budget: ExecutionBudget;
}

export interface StoredWorkflowRun {
  view: ExecutionView;
  workflow: WorkflowDefinition;
  workflowVersion: number;
  grantedPermissions: string[];
  budget: ExecutionBudget;
}

export interface FinishStepInput {
  id: string;
  executionId: string;
  nodeId: string;
  attempt: number;
  status: "completed" | "failed" | "cancelled" | "interrupted";
  finishedAt: Date;
  outputContexts: ContextEnvelope[];
  error: StructuredExecutionError | null;
}

export interface WorkflowExecutionStore extends ExecutionRepository {
  /** Snapshot validated inputs, enqueue, and create execution atomically. */
  submit(input: ExecutionSubmission): Promise<ExecutionRecord>;
  /** Trusted worker-only lookup; never expose unscoped results to HTTP clients. */
  load(executionId: string): Promise<StoredWorkflowRun | null>;
  startStep(step: ExecutionStepRecord): Promise<void>;
  finishStep(step: FinishStepInput): Promise<void>;
}
