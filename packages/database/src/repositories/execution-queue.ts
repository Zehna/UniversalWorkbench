import type {
  EnqueueQueueJobInput,
  ExecutionQueue,
  QueueJob,
} from "@uw/execution";
import type { Pool, QueryResultRow } from "pg";

interface QueueRow extends QueryResultRow {
  id: string;
  execution_id: string;
  step_execution_id: string | null;
  queue_type: "execution" | "step";
  attempt: number;
  available_at: Date;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const QUEUE_COLUMNS = `
  id,
  execution_id,
  step_execution_id,
  queue_type,
  attempt,
  available_at,
  lease_owner,
  lease_expires_at,
  created_at,
  updated_at
`;

const QUALIFIED_QUEUE_COLUMNS = `
  q.id,
  q.execution_id,
  q.step_execution_id,
  q.queue_type,
  q.attempt,
  q.available_at,
  q.lease_owner,
  q.lease_expires_at,
  q.created_at,
  q.updated_at
`;

function mapQueueJob(row: QueueRow): QueueJob {
  return {
    id: row.id,
    executionId: row.execution_id,
    stepExecutionId: row.step_execution_id,
    queueType: row.queue_type,
    attempt: row.attempt,
    availableAt: row.available_at.toISOString(),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function assertLeaseMs(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new RangeError("leaseMs must be a positive safe integer");
  }
}

function assertAttempt(attempt: number): void {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new RangeError("attempt must be a non-negative safe integer");
  }
}

async function insertQueueJob(
  pool: Pool,
  input: EnqueueQueueJobInput,
): Promise<QueueJob> {
  assertAttempt(input.attempt);
  const result = await pool.query<QueueRow>(
    `insert into execution_queue (
       id,
       execution_id,
       step_execution_id,
       queue_type,
       attempt,
       available_at,
       created_at,
       updated_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, $7)
     on conflict (id) do nothing
     returning ${QUEUE_COLUMNS}`,
    [
      input.id,
      input.executionId,
      input.stepExecutionId,
      input.queueType,
      input.attempt,
      input.availableAt,
      input.createdAt,
    ],
  );
  const row = result.rows[0];
  if (row) return mapQueueJob(row);

  const existing = await pool.query<QueueRow>(
    `select ${QUEUE_COLUMNS}
       from execution_queue
      where id = $1
      limit 1`,
    [input.id],
  );
  const current = existing.rows[0];
  if (!current) throw new Error("Execution queue insert returned no row");
  if (
    current.execution_id !== input.executionId ||
    current.step_execution_id !== input.stepExecutionId ||
    current.queue_type !== input.queueType
  ) {
    throw new Error("Execution queue idempotency key collision");
  }
  return mapQueueJob(current);
}

export function createPostgresExecutionQueue(pool: Pool): ExecutionQueue {
  return {
    enqueue(input) {
      return insertQueueJob(pool, input);
    },

    async claim(workerId, now, leaseMs) {
      if (workerId.trim().length === 0) {
        throw new Error("workerId is required");
      }
      assertLeaseMs(leaseMs);

      const client = await pool.connect();
      try {
        await client.query("begin");

        const result = await client.query<QueueRow>(
          `with candidate as (
             select q.id
               from execution_queue q
               join executions e on e.id = q.execution_id
              where (
                  q.available_at <= $2::timestamptz
                  or e.cancellation_requested_at is not null
                )
                and (
                  q.lease_expires_at is null
                  or q.lease_expires_at <= $2::timestamptz
                )
                and (
                  e.status in ('queued', 'running')
                  or (
                    e.status = 'cancelled'
                    and e.cancellation_requested_at is not null
                  )
                )
              order by q.available_at, q.created_at, q.id
              for update of q skip locked
              limit 1
           )
           update execution_queue q
              set lease_owner = $1,
                  lease_expires_at =
                    $2::timestamptz + ($3::bigint * interval '1 millisecond'),
                  updated_at = $2::timestamptz
             from candidate c
            where q.id = c.id
           returning ${QUALIFIED_QUEUE_COLUMNS}`,
          [workerId, now, leaseMs],
        );

        await client.query("commit");
        const row = result.rows[0];
        return row ? mapQueueJob(row) : null;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async complete(jobId, workerId) {
      const result = await pool.query(
        `delete from execution_queue
          where id = $1
            and lease_owner = $2`,
        [jobId, workerId],
      );
      return result.rowCount === 1;
    },

    async releaseForRetry(jobId, workerId, availableAt, attempt) {
      assertAttempt(attempt);
      const result = await pool.query(
        `update execution_queue
            set attempt = $3,
                available_at = $4,
                lease_owner = null,
                lease_expires_at = null,
                updated_at = now()
          where id = $1
            and lease_owner = $2`,
        [jobId, workerId, attempt, availableAt],
      );
      return result.rowCount === 1;
    },

    async abandon(jobId, workerId) {
      const result = await pool.query(
        `update execution_queue
            set lease_owner = null,
                lease_expires_at = null,
                updated_at = now()
          where id = $1
            and lease_owner = $2`,
        [jobId, workerId],
      );
      return result.rowCount === 1;
    },

    async discardUnleased(jobId) {
      const result = await pool.query(
        `delete from execution_queue
          where id = $1
            and lease_owner is null`,
        [jobId],
      );
      return result.rowCount === 1;
    },
  };
}
