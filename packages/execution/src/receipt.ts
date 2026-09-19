import type { ExecutionReceipt } from "@uw/contracts";

export interface ExecutionReceiptRepository {
  append(receipt: ExecutionReceipt): Promise<void>;
  listByExecution(executionId: string): Promise<ExecutionReceipt[]>;
}
