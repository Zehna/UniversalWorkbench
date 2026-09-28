export interface QueueLease {
  executionId: string;
  workerId: string;
  leaseToken: string;
  attempt: number;
  leasedUntil: Date;
}

export interface ExecutionQueue {
  enqueue(executionId: string, availableAt: Date): Promise<void>;
  claim(
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<QueueLease | null>;
  ack(lease: QueueLease): Promise<void>;
  release(lease: QueueLease, availableAt: Date): Promise<void>;
  renew(lease: QueueLease, now: Date, leaseMs: number): Promise<QueueLease>;
}

export class ExecutionQueueError extends Error {
  constructor(
    public readonly code: "INVALID_ARGUMENT" | "NOT_QUEUED" | "LEASE_LOST",
    message: string,
  ) {
    super(message);
    this.name = "ExecutionQueueError";
  }
}
