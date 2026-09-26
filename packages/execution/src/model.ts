import type { ContextEnvelope, ExecutionStatus } from "@uw/contracts";

export type ExecutionJson = Record<string, unknown>;

export interface StructuredExecutionError {
  code: string;
  message: string;
  details: ExecutionJson | null;
}

export interface ExecutionRecord {
  id: string;
  ownerId: string;
  projectId: string;
  workflowDefinitionId: string;
  status: ExecutionStatus;
  traceId: string;
  inputContext: ContextEnvelope;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: StructuredExecutionError | null;
  usage: ExecutionJson;
  createdAt: Date;
}

export interface ProvenanceEdgeRecord {
  fromContextId: string;
  toContextId: string;
  nodeId: string;
}

export interface ExecutionStepRecord {
  id: string;
  executionId: string;
  nodeId: string;
  toolId: string;
  toolVersion: string;
  attempt: number;
  status: ExecutionStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  inputContext: ContextEnvelope;
  outputContexts: ContextEnvelope[];
  error: StructuredExecutionError | null;
  idempotencyKey: string | null;
}

export interface CreateExecutionRecord {
  id: string;
  ownerId: string;
  projectId: string;
  workflowDefinitionId: string;
  traceId: string;
  inputContext: ContextEnvelope;
  createdAt: Date;
}

export interface CompleteExecutionRecord {
  executionId: string;
  finishedAt: Date;
  usage: ExecutionJson;
  receipt: ExecutionJson;
}

export interface FailExecutionRecord {
  executionId: string;
  finishedAt: Date;
  error: StructuredExecutionError;
  usage: ExecutionJson;
  receipt: ExecutionJson;
}

export interface ExecutionView {
  execution: ExecutionRecord;
  steps: ExecutionStepRecord[];
  provenanceEdges: ProvenanceEdgeRecord[];
  receipt: ExecutionJson | null;
}
