import type { ExecutionReceipt } from "@uw/contracts";

export interface ExecutionReceiptRepository {
  append(receipt: ExecutionReceipt): Promise<ExecutionReceipt>;
  getByStep(stepExecutionId: string): Promise<ExecutionReceipt | null>;
  listByExecution(executionId: string): Promise<ExecutionReceipt[]>;
}
