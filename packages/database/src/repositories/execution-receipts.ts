import { ExecutionReceiptSchema, type ExecutionReceipt } from "@uw/contracts";
import type { ExecutionReceiptRepository } from "@uw/execution";
import type { Pool, PoolClient, QueryResultRow } from "pg";

interface ReceiptRow extends QueryResultRow {
  receipt: unknown;
}

function parseReceipt(row: ReceiptRow | undefined): ExecutionReceipt | null {
  return row ? ExecutionReceiptSchema.parse(row.receipt) : null;
}

async function findByStep(
  client: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  stepExecutionId: string,
): Promise<ExecutionReceipt | null> {
  const result = await client.query<ReceiptRow>(
    `select receipt
       from execution_receipts
      where step_execution_id = $1
      order by created_at, id
      limit 1`,
    [stepExecutionId],
  );
  return parseReceipt(result.rows[0]);
}

async function insertReceipt(
  client: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  receipt: ExecutionReceipt,
): Promise<void> {
  await client.query(
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
}

export function createPostgresExecutionReceiptRepository(
  pool: Pool,
): ExecutionReceiptRepository {
  return {
    async append(receipt) {
      if (!receipt.stepExecutionId) {
        await insertReceipt(pool, receipt);
        return receipt;
      }

      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [receipt.stepExecutionId],
        );

        const existing = await findByStep(client, receipt.stepExecutionId);
        if (existing) {
          await client.query("commit");
          return existing;
        }

        await insertReceipt(client, receipt);
        await client.query("commit");
        return receipt;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    getByStep(stepExecutionId) {
      return findByStep(pool, stepExecutionId);
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
