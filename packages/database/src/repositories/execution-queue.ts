import { randomUUID } from "node:crypto";
import type { QueueLease, ExecutionQueue } from "@uw/execution";
import { ExecutionQueueError } from "@uw/execution";
import type { Pool, QueryResultRow } from "pg";

interface LeaseRow extends QueryResultRow {
  execution_id: string;
  lease_owner: string;
  lease_token: string;
  leased_until: Date;
  attempts: number;
}

function validDate(date: Date): boolean {
  return date instanceof Date && Number.isFinite(date.getTime());
}

function validateLeaseMs(ms: number): void {
  if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 3_600_000) {
    throw new ExecutionQueueError(
      "INVALID_ARGUMENT",
      "Lease duration must be 1s to 1h",
    );
  }
}

function requireLiveLease(rowCount: number | null): void {
  if (rowCount !== 1) {
    throw new ExecutionQueueError(
      "LEASE_LOST",
      "Queue lease no longer belongs to this worker",
    );
  }
}

function toLease(row: LeaseRow): QueueLease {
  return {
    executionId: row.execution_id,
    workerId: row.lease_owner,
    leaseToken: row.lease_token,
    leasedUntil: row.leased_until,
    attempt: row.attempts,
  };
}

export function createPostgresExecutionQueue(
  pool: Pool,
  options: { now?: () => Date } = {},
): ExecutionQueue {
  const clock = options.now ?? (() => new Date());

  return {
    async enqueue(executionId, availableAt) {
      if (!executionId || !validDate(availableAt)) {
        throw new ExecutionQueueError(
          "INVALID_ARGUMENT",
          "Execution ID and availability are required",
        );
      }

      // Insert only for queued executions; do not reset an existing lease or
      // change a previously scheduled queue entry on duplicate submissions.
      const inserted = await pool.query(
        `insert into execution_queue (execution_id, available_at)
         select id, $2 from executions where id = $1 and status = 'queued'
         on conflict (execution_id) do nothing`,
        [executionId, availableAt],
      );
      if (inserted.rowCount === 1) return;
      const existing = await pool.query(
        "select 1 from execution_queue q join executions e on e.id = q.execution_id where q.execution_id = $1 and e.status = 'queued'",
        [executionId],
      );
      if (existing.rowCount !== 1) {
        throw new ExecutionQueueError(
          "NOT_QUEUED",
          "Execution is not available for enqueuing",
        );
      }
    },

    async claim(workerId, now, leaseMs) {
      if (!workerId || workerId.length > 128 || !validDate(now)) {
        throw new ExecutionQueueError(
          "INVALID_ARGUMENT",
          "Worker ID and claim time are required",
        );
      }
      validateLeaseMs(leaseMs);
      const leaseToken = randomUUID();
      const expires = new Date(now.getTime() + leaseMs);
      const claimed = await pool.query<LeaseRow>(
        `with candidate as (
          select q.execution_id from execution_queue q
          join executions e on e.id = q.execution_id
          where q.available_at <= $1
            and (q.leased_until is null or q.leased_until <= $1)
            and e.status in ('queued', 'running')
          order by q.available_at, q.enqueued_at, q.execution_id
          for update of q skip locked
          limit 1
        )
        update execution_queue q
           set lease_owner = $2,
               lease_token = $3,
               leased_until = $4,
               attempts = q.attempts + 1
          from candidate
         where q.execution_id = candidate.execution_id
        returning q.execution_id, q.lease_owner, q.lease_token,
                  q.leased_until, q.attempts`,
        [now, workerId, leaseToken, expires],
      );
      return claimed.rows[0] ? toLease(claimed.rows[0]) : null;
    },

    async ack(lease) {
      const result = await pool.query(
        `delete from execution_queue
         where execution_id = $1 and lease_owner = $2 and lease_token = $3
           and leased_until > $4`,
        [lease.executionId, lease.workerId, lease.leaseToken, clock()],
      );
      requireLiveLease(result.rowCount);
    },

    async release(lease, availableAt) {
      if (!validDate(availableAt)) {
        throw new ExecutionQueueError(
          "INVALID_ARGUMENT",
          "Release time is invalid",
        );
      }
      const result = await pool.query(
        `update execution_queue
            set lease_owner = null, lease_token = null, leased_until = null,
                available_at = $4
          where execution_id = $1 and lease_owner = $2 and lease_token = $3
            and leased_until > $5`,
        [
          lease.executionId,
          lease.workerId,
          lease.leaseToken,
          availableAt,
          clock(),
        ],
      );
      requireLiveLease(result.rowCount);
    },

    async renew(lease, now, leaseMs) {
      if (!validDate(now)) {
        throw new ExecutionQueueError(
          "INVALID_ARGUMENT",
          "Renewal time is invalid",
        );
      }
      validateLeaseMs(leaseMs);
      const expires = new Date(now.getTime() + leaseMs);
      const result = await pool.query<LeaseRow>(
        `update execution_queue
            set leased_until = $4
          where execution_id = $1 and lease_owner = $2 and lease_token = $3
            and leased_until > $5
          returning execution_id, lease_owner, lease_token, leased_until, attempts`,
        [lease.executionId, lease.workerId, lease.leaseToken, expires, now],
      );
      if (!result.rows[0]) {
        throw new ExecutionQueueError(
          "LEASE_LOST",
          "Queue lease can no longer be renewed",
        );
      }
      return toLease(result.rows[0]);
    },
  };
}
