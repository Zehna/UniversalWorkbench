import { ExecutionReceiptSchema, type ExecutionReceipt } from "@uw/contracts";
import type { ExecutionReceiptRepository } from "@uw/execution";
import type { Pool, QueryResultRow } from "pg";

interface ReceiptRow extends QueryResultRow {
  receipt: unknown;
}

export function createPostgresExecutionReceiptRepository(
  pool: Pool,
): ExecutionReceiptRepository {
  return {
    async append(receipt) {
      await pool.query(
        `insert into execution_receipts (
           id,
           execution_id,
           step_execution_id,
           receipt
         ) values ($1, $2, $3, $4::jsonb)`,
        [
          receipt.id,
          receipt.executionId,
          receipt.stepExecutionId,
          JSON.stringify(receipt),
        ],
      );
    },

    async listByExecution(executionId) {
      const result = await pool.query<ReceiptRow>(
        `select receipt
           from execution_receipts
          where execution_id = $1
          order by created_at, id`,
        [executionId],
      );
      return result.rows.map((row): ExecutionReceipt =>
        ExecutionReceiptSchema.parse(row.receipt),
      );
    },
  };
}
