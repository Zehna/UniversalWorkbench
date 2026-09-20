export type ExecutionQueueType = "execution" | "step";

export interface QueueJob {
  id: string;
  executionId: string;
  stepExecutionId: string | null;
  queueType: ExecutionQueueType;
  attempt: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueQueueJobInput {
  id: string;
  executionId: string;
  stepExecutionId: string | null;
  queueType: ExecutionQueueType;
  attempt: number;
  availableAt: string;
  createdAt: string;
}

export interface ExecutionQueue {
  enqueue(input: EnqueueQueueJobInput): Promise<QueueJob>;
  claim(
    workerId: string,
    now: string,
    leaseMs: number,
  ): Promise<QueueJob | null>;
  complete(jobId: string, workerId: string): Promise<boolean>;
  releaseForRetry(
    jobId: string,
    workerId: string,
    availableAt: string,
    attempt: number,
  ): Promise<boolean>;
  abandon(jobId: string, workerId: string): Promise<boolean>;
}
