import type {
  Execution,
  ExecutionKind,
  JsonObject,
  ExecutionStatus,
  ExecutionUsage,
  SanitizedExecutionError,
  StepExecutionStatus,
} from "@uw/contracts";

export interface ExecutionStepRecord {
  id: string;
  executionId: string;
  nodeId: string;
  toolId: string;
  toolVersion: string;
  config: JsonObject;
  status: StepExecutionStatus;
  attempt: number;
  inputContextIds: string[];
  outputContextIds: string[];
  startedAt: string | null;
  finishedAt: string | null;
  error: SanitizedExecutionError | null;
  usage: ExecutionUsage;
}

export interface CreateExecutionInput {
  execution: Execution;
}

export interface ExecutionRepository {
  create(input: CreateExecutionInput): Promise<Execution>;
  getById(ownerId: string, executionId: string): Promise<Execution | null>;
  getByIdForWorker(executionId: string): Promise<Execution | null>;
  findByIdempotencyKey(input: {
    ownerId: string;
    projectId: string;
    kind: ExecutionKind;
    idempotencyKey: string;
  }): Promise<Execution | null>;
  transition(input: {
    ownerId: string;
    executionId: string;
    from: ExecutionStatus;
    to: ExecutionStatus;
    now: string;
    error?: SanitizedExecutionError | null;
  }): Promise<Execution | null>;
  requestCancellation(input: {
    ownerId: string;
    executionId: string;
    now: string;
  }): Promise<Execution | null>;
}

export interface TransitionExecutionStepInput {
  stepExecutionId: string;
  from: StepExecutionStatus;
  to: StepExecutionStatus;
  now: string;
  attempt?: number;
  inputContextIds?: string[];
  outputContextIds?: string[];
  error?: SanitizedExecutionError | null;
  usage?: ExecutionUsage;
}

export interface ExecutionStepRepository {
  create(step: ExecutionStepRecord): Promise<ExecutionStepRecord>;
  listByExecution(executionId: string): Promise<ExecutionStepRecord[]>;
  getById(stepExecutionId: string): Promise<ExecutionStepRecord | null>;
  transition(
    input: TransitionExecutionStepInput,
  ): Promise<ExecutionStepRecord | null>;
}
