import type {
  CompleteExecutionRecord,
  CreateExecutionRecord,
  ExecutionRecord,
  ExecutionStepRecord,
  ExecutionView,
  FailExecutionRecord,
} from "./model.js";

export interface ExecutionRepository {
  createExecution(input: CreateExecutionRecord): Promise<ExecutionRecord>;
  markRunning(executionId: string, startedAt: Date): Promise<void>;
  recordStep(input: ExecutionStepRecord): Promise<void>;
  complete(input: CompleteExecutionRecord): Promise<void>;
  fail(input: FailExecutionRecord): Promise<void>;
  cancel(
    executionId: string,
    finishedAt: Date,
    receipt?: Record<string, unknown>,
  ): Promise<void>;
  get(
    ownerId: string,
    projectId: string,
    executionId: string,
  ): Promise<ExecutionView | null>;
}

export class ExecutionRepositoryError extends Error {
  constructor(
    public readonly code:
      | "INVALID_STATE"
      | "EXECUTION_SCOPE_MISMATCH"
      | "DUPLICATE_STEP"
      | "RECEIPT_EXISTS",
    message: string,
  ) {
    super(message);
    this.name = "ExecutionRepositoryError";
  }
}
