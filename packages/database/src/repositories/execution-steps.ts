import {
  ExecutionUsageSchema,
  JsonObjectSchema,
  SanitizedExecutionErrorSchema,
  type StepExecutionStatus,
} from "@uw/contracts";
import {
  InvalidStepTransitionError,
  canTransitionStep,
  type ExecutionStepRecord,
  type ExecutionStepRepository,
} from "@uw/execution";
import type { Pool, QueryResultRow } from "pg";

interface StepRow extends QueryResultRow {
  id: string;
  execution_id: string;
  node_id: string;
  tool_id: string;
  tool_version: string;
  config: unknown;
  status: StepExecutionStatus;
  attempt: number;
  input_context_ids: unknown;
  output_context_ids: unknown;
  started_at: Date | null;
  finished_at: Date | null;
  error: unknown | null;
  usage: unknown;
}

const STEP_COLUMNS = `
  id,
  execution_id,
  node_id,
  tool_id,
  tool_version,
  config,
  status,
  attempt,
  input_context_ids,
  output_context_ids,
  started_at,
  finished_at,
  error,
  usage
`;

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Execution step context ids are invalid");
  }
  return [...value];
}

function mapStep(row: StepRow): ExecutionStepRecord {
  return {
    id: row.id,
    executionId: row.execution_id,
    nodeId: row.node_id,
    toolId: row.tool_id,
    toolVersion: row.tool_version,
    config: JsonObjectSchema.parse(row.config),
    status: row.status,
    attempt: row.attempt,
    inputContextIds: stringArray(row.input_context_ids),
    outputContextIds: stringArray(row.output_context_ids),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    error: row.error ? SanitizedExecutionErrorSchema.parse(row.error) : null,
    usage: ExecutionUsageSchema.parse(row.usage),
  };
}

async function byExecutionNode(
  pool: Pool,
  executionId: string,
  nodeId: string,
): Promise<ExecutionStepRecord | null> {
  const result = await pool.query<StepRow>(
    `select ${STEP_COLUMNS}
       from execution_steps
      where execution_id = $1
        and node_id = $2
      limit 1`,
    [executionId, nodeId],
  );
  const row = result.rows[0];
  return row ? mapStep(row) : null;
}

export function createPostgresExecutionStepRepository(
  pool: Pool,
): ExecutionStepRepository {
  return {
    async create(step) {
      const result = await pool.query<StepRow>(
        `insert into execution_steps (
           id,
           execution_id,
           node_id,
           tool_id,
           tool_version,
           config,
           status,
           attempt,
           input_context_ids,
           output_context_ids,
           started_at,
           finished_at,
           error,
           usage
         ) values (
           $1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb,$14::jsonb
         )
         on conflict (execution_id, node_id) do nothing
         returning ${STEP_COLUMNS}`,
        [
          step.id,
          step.executionId,
          step.nodeId,
          step.toolId,
          step.toolVersion,
          JSON.stringify(step.config),
          step.status,
          step.attempt,
          JSON.stringify(step.inputContextIds),
          JSON.stringify(step.outputContextIds),
          step.startedAt,
          step.finishedAt,
          step.error ? JSON.stringify(step.error) : null,
          JSON.stringify(step.usage),
        ],
      );
      const row = result.rows[0];
      if (row) return mapStep(row);

      const existing = await byExecutionNode(pool, step.executionId, step.nodeId);
      if (!existing) throw new Error("Execution step insert returned no row");
      return existing;
    },

    async listByExecution(executionId) {
      const result = await pool.query<StepRow>(
        `select ${STEP_COLUMNS}
           from execution_steps
          where execution_id = $1
          order by node_id, id`,
        [executionId],
      );
      return result.rows.map(mapStep);
    },

    async getById(stepExecutionId) {
      const result = await pool.query<StepRow>(
        `select ${STEP_COLUMNS}
           from execution_steps
          where id = $1
          limit 1`,
        [stepExecutionId],
      );
      const row = result.rows[0];
      return row ? mapStep(row) : null;
    },

    async transition(input) {
      if (!canTransitionStep(input.from, input.to)) {
        throw new InvalidStepTransitionError(input.from, input.to);
      }

      const assignments = ["status = $3", "updated_at = $4"];
      const values: unknown[] = [
        input.stepExecutionId,
        input.from,
        input.to,
        input.now,
      ];

      if (input.to === "running") {
        assignments.push("started_at = coalesce(started_at, $4)");
      }
      if (
        input.to === "succeeded" ||
        input.to === "failed" ||
        input.to === "skipped" ||
        input.to === "cancelled" ||
        input.to === "timed_out"
      ) {
        assignments.push("finished_at = $4");
      } else {
        assignments.push("finished_at = null");
      }

      if (input.attempt !== undefined) {
        values.push(input.attempt);
        assignments.push(`attempt = $${values.length}`);
      }
      if (input.inputContextIds !== undefined) {
        values.push(JSON.stringify(input.inputContextIds));
        assignments.push(`input_context_ids = $${values.length}::jsonb`);
      }
      if (input.outputContextIds !== undefined) {
        values.push(JSON.stringify(input.outputContextIds));
        assignments.push(`output_context_ids = $${values.length}::jsonb`);
      }
      if (input.error !== undefined) {
        values.push(input.error ? JSON.stringify(input.error) : null);
        assignments.push(`error = $${values.length}::jsonb`);
      }
      if (input.usage !== undefined) {
        values.push(JSON.stringify(input.usage));
        assignments.push(`usage = $${values.length}::jsonb`);
      }

      const result = await pool.query<StepRow>(
        `update execution_steps
            set ${assignments.join(", ")}
          where id = $1
            and status = $2
        returning ${STEP_COLUMNS}`,
        values,
      );
      const row = result.rows[0];
      return row ? mapStep(row) : null;
    },
  };
}
