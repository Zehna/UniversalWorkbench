import {
  ExecutionBudgetSchema,
  ExecutionSchema,
  SanitizedExecutionErrorSchema,
  type Execution,
  type ExecutionStatus,
} from "@uw/contracts";
import {
  InvalidExecutionTransitionError,
  canTransitionExecution,
  type ExecutionRepository,
} from "@uw/execution";
import type { Pool, QueryResultRow } from "pg";

interface ExecutionRow extends QueryResultRow {
  id: string;
  owner_id: string;
  project_id: string;
  kind: "tool" | "workflow";
  workflow_revision_id: string | null;
  status: ExecutionStatus;
  trace_id: string;
  idempotency_key: string;
  budget: unknown;
  queued_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  cancellation_requested_at: Date | null;
  error: unknown | null;
}

const EXECUTION_COLUMNS = `
  id,
  owner_id,
  project_id,
  kind,
  workflow_revision_id,
  status,
  trace_id,
  idempotency_key,
  budget,
  queued_at,
  started_at,
  finished_at,
  cancellation_requested_at,
  error
`;

function mapExecution(row: ExecutionRow): Execution {
  return ExecutionSchema.parse({
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    kind: row.kind,
    status: row.status,
    traceId: row.trace_id,
    idempotencyKey: row.idempotency_key,
    budget: ExecutionBudgetSchema.parse(row.budget),
    queuedAt: row.queued_at.toISOString(),
    ...(row.workflow_revision_id
      ? { workflowRevisionId: row.workflow_revision_id }
      : {}),
    ...(row.started_at ? { startedAt: row.started_at.toISOString() } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at.toISOString() } : {}),
    ...(row.cancellation_requested_at
      ? { cancellationRequestedAt: row.cancellation_requested_at.toISOString() }
      : {}),
    ...(row.error
      ? { error: SanitizedExecutionErrorSchema.parse(row.error) }
      : {}),
  });
}

async function selectByIdempotency(
  pool: Pool,
  input: {
    ownerId: string;
    projectId: string;
    kind: "tool" | "workflow";
    idempotencyKey: string;
  },
): Promise<Execution | null> {
  const result = await pool.query<ExecutionRow>(
    `select ${EXECUTION_COLUMNS}
       from executions
      where owner_id = $1
        and project_id = $2
        and kind = $3
        and idempotency_key = $4
      limit 1`,
    [input.ownerId, input.projectId, input.kind, input.idempotencyKey],
  );
  const row = result.rows[0];
  return row ? mapExecution(row) : null;
}

export function createPostgresExecutionRepository(
  pool: Pool,
): ExecutionRepository {
  return {
    async create({ execution }) {
      const inserted = await pool.query<ExecutionRow>(
        `insert into executions (
           id,
           owner_id,
           project_id,
           kind,
           workflow_revision_id,
           status,
           trace_id,
           idempotency_key,
           budget,
           queued_at,
           started_at,
           finished_at,
           cancellation_requested_at,
           error
         )
         select
           $1,
           $2,
           p.id,
           $4,
           $5,
           $6,
           $7,
           $8,
           $9::jsonb,
           $10,
           $11,
           $12,
           $13,
           $14::jsonb
         from projects p
         where p.id = $3
           and p.owner_id = $2
           and p.deleted_at is null
         on conflict (
           owner_id,
           project_id,
           kind,
           idempotency_key
         ) do nothing
         returning ${EXECUTION_COLUMNS}`,
        [
          execution.id,
          execution.ownerId,
          execution.projectId,
          execution.kind,
          execution.workflowRevisionId ?? null,
          execution.status,
          execution.traceId,
          execution.idempotencyKey,
          JSON.stringify(execution.budget),
          execution.queuedAt,
          execution.startedAt ?? null,
          execution.finishedAt ?? null,
          execution.cancellationRequestedAt ?? null,
          execution.error ? JSON.stringify(execution.error) : null,
        ],
      );

      const row = inserted.rows[0];
      if (row) return mapExecution(row);

      const existing = await selectByIdempotency(pool, {
        ownerId: execution.ownerId,
        projectId: execution.projectId,
        kind: execution.kind,
        idempotencyKey: execution.idempotencyKey,
      });
      if (existing) return existing;

      throw new Error("Execution project was not found for owner");
    },

    async getById(ownerId, executionId) {
      const result = await pool.query<ExecutionRow>(
        `select ${EXECUTION_COLUMNS}
           from executions
          where owner_id = $1
            and id = $2
          limit 1`,
        [ownerId, executionId],
      );
      const row = result.rows[0];
      return row ? mapExecution(row) : null;
    },

    async getByIdForWorker(executionId) {
      const result = await pool.query<ExecutionRow>(
        `select ${EXECUTION_COLUMNS}
           from executions
          where id = $1
          limit 1`,
        [executionId],
      );
      const row = result.rows[0];
      return row ? mapExecution(row) : null;
    },

    findByIdempotencyKey(input) {
      return selectByIdempotency(pool, input);
    },

    async transition(input) {
      if (!canTransitionExecution(input.from, input.to)) {
        throw new InvalidExecutionTransitionError(input.from, input.to);
      }

      const assignments = ["status = $4", "updated_at = $5"];
      const values: unknown[] = [
        input.ownerId,
        input.executionId,
        input.from,
        input.to,
        input.now,
      ];

      if (input.to === "running") {
        assignments.push("started_at = coalesce(started_at, $5)");
      }

      if (
        input.to === "succeeded" ||
        input.to === "failed" ||
        input.to === "cancelled" ||
        input.to === "timed_out"
      ) {
        assignments.push("finished_at = $5");
      }

      if (input.error !== undefined) {
        values.push(input.error ? JSON.stringify(input.error) : null);
        assignments.push(`error = $${values.length}::jsonb`);
      }

      const result = await pool.query<ExecutionRow>(
        `update executions
            set ${assignments.join(", ")}
          where owner_id = $1
            and id = $2
            and status = $3
        returning ${EXECUTION_COLUMNS}`,
        values,
      );
      const row = result.rows[0];
      return row ? mapExecution(row) : null;
    },

    async requestCancellation(input) {
      const updated = await pool.query<ExecutionRow>(
        `update executions
            set cancellation_requested_at = $3,
                updated_at = $3
          where owner_id = $1
            and id = $2
            and status in ('queued', 'running')
        returning ${EXECUTION_COLUMNS}`,
        [input.ownerId, input.executionId, input.now],
      );
      const row = updated.rows[0];
      if (row) return mapExecution(row);

      const existing = await pool.query<ExecutionRow>(
        `select ${EXECUTION_COLUMNS}
           from executions
          where owner_id = $1
            and id = $2
          limit 1`,
        [input.ownerId, input.executionId],
      );
      const current = existing.rows[0];
      return current ? mapExecution(current) : null;
    },
  };
}
