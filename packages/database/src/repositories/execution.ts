import type {
  CompleteExecutionRecord,
  ExecutionJson,
  ExecutionRecord,
  ExecutionRepository,
  ExecutionStepRecord,
  ExecutionView,
  FailExecutionRecord,
  ProvenanceEdgeRecord,
  StructuredExecutionError,
} from "@uw/execution";
import { ExecutionRepositoryError } from "@uw/execution";
import type { ContextEnvelope, ExecutionStatus } from "@uw/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

interface ExecutionRow extends QueryResultRow {
  id: string;
  owner_id: string;
  project_id: string;
  workflow_definition_id: string;
  status: ExecutionStatus;
  trace_id: string;
  input_context: ContextEnvelope;
  started_at: Date | null;
  finished_at: Date | null;
  error: StructuredExecutionError | null;
  usage: ExecutionJson;
  created_at: Date;
}

interface ExecutionStepRow extends QueryResultRow {
  id: string;
  execution_id: string;
  node_id: string;
  tool_id: string;
  tool_version: string;
  attempt: number;
  status: ExecutionStatus;
  started_at: Date | null;
  finished_at: Date | null;
  input_context: ContextEnvelope;
  output_contexts: ContextEnvelope[];
  error: StructuredExecutionError | null;
  idempotency_key: string | null;
}

interface ProvenanceRow extends QueryResultRow {
  from_context_id: string;
  to_context_id: string;
  node_id: string;
}

const EXECUTION_COLUMNS = `
  id,
  owner_id,
  project_id,
  workflow_definition_id,
  status,
  trace_id,
  input_context,
  started_at,
  finished_at,
  error,
  usage,
  created_at
`;

const STEP_COLUMNS = `
  id,
  execution_id,
  node_id,
  tool_id,
  tool_version,
  attempt,
  status,
  started_at,
  finished_at,
  input_context,
  output_contexts,
  error,
  idempotency_key
`;

function mapExecution(row: ExecutionRow): ExecutionRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    workflowDefinitionId: row.workflow_definition_id,
    status: row.status,
    traceId: row.trace_id,
    inputContext: row.input_context,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    usage: row.usage,
    createdAt: row.created_at,
  };
}

function mapStep(row: ExecutionStepRow): ExecutionStepRecord {
  return {
    id: row.id,
    executionId: row.execution_id,
    nodeId: row.node_id,
    toolId: row.tool_id,
    toolVersion: row.tool_version,
    attempt: row.attempt,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    inputContext: row.input_context,
    outputContexts: row.output_contexts,
    error: row.error,
    idempotencyKey: row.idempotency_key,
  };
}

function requireUpdated(rowCount: number | null, message: string): void {
  if (rowCount !== 1) {
    throw new ExecutionRepositoryError("INVALID_STATE", message);
  }
}

async function insertReceipt(
  client: PoolClient,
  executionId: string,
  receipt: ExecutionJson,
  createdAt: Date,
): Promise<void> {
  try {
    await client.query(
      `insert into execution_receipts (execution_id, receipt, created_at)
       values ($1, $2::jsonb, $3)`,
      [executionId, JSON.stringify(receipt), createdAt],
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      throw new ExecutionRepositoryError(
        "RECEIPT_EXISTS",
        "Execution already has an immutable final receipt",
      );
    }
    throw error;
  }
}

async function terminalTransition(
  pool: Pool,
  input:
    | ({ status: "completed" } & CompleteExecutionRecord)
    | ({ status: "failed" } & FailExecutionRecord),
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query(
      `update executions
          set status = $2,
              finished_at = $3,
              error = $4::jsonb,
              usage = $5::jsonb
        where id = $1
          and status = 'running'`,
      [
        input.executionId,
        input.status,
        input.finishedAt,
        input.status === "failed" ? JSON.stringify(input.error) : null,
        JSON.stringify(input.usage),
      ],
    );
    requireUpdated(result.rowCount, "Execution is not running");
    await insertReceipt(
      client,
      input.executionId,
      input.receipt,
      input.finishedAt,
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function createPostgresExecutionRepository(
  pool: Pool,
): ExecutionRepository {
  return {
    async createExecution(input) {
      const result = await pool.query<ExecutionRow>(
        `insert into executions (
           id, owner_id, project_id, workflow_definition_id,
           status, trace_id, input_context, usage, created_at
         )
         select
           $1, w.owner_id, w.project_id, w.id,
           'queued', $5, $6::jsonb, '{}'::jsonb, $7
           from workflow_definitions w
           join projects p
             on p.id = w.project_id
            and p.owner_id = w.owner_id
          where w.id = $4
            and w.owner_id = $2
            and w.project_id = $3
            and p.deleted_at is null
         returning ${EXECUTION_COLUMNS}`,
        [
          input.id,
          input.ownerId,
          input.projectId,
          input.workflowDefinitionId,
          input.traceId,
          JSON.stringify(input.inputContext),
          input.createdAt,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new ExecutionRepositoryError(
          "EXECUTION_SCOPE_MISMATCH",
          "Workflow definition is not available in the requested owner/project scope",
        );
      }
      return mapExecution(row);
    },

    async markRunning(executionId, startedAt) {
      const result = await pool.query(
        `update executions
            set status = 'running',
                started_at = $2
          where id = $1
            and status = 'queued'`,
        [executionId, startedAt],
      );
      requireUpdated(result.rowCount, "Execution is not queued");
    },

    async recordStep(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const execution = await client.query<{ status: ExecutionStatus }>(
          "select status from executions where id = $1 for update",
          [input.executionId],
        );
        if (execution.rows[0]?.status !== "running") {
          throw new ExecutionRepositoryError(
            "INVALID_STATE",
            "Steps can only be recorded for a running execution",
          );
        }

        try {
          await client.query(
            `insert into execution_steps (
               id, execution_id, node_id, tool_id, tool_version, attempt,
               status, started_at, finished_at, input_context, output_contexts,
               error, idempotency_key
             ) values (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13
             )`,
            [
              input.id,
              input.executionId,
              input.nodeId,
              input.toolId,
              input.toolVersion,
              input.attempt,
              input.status,
              input.startedAt,
              input.finishedAt,
              JSON.stringify(input.inputContext),
              JSON.stringify(input.outputContexts),
              input.error ? JSON.stringify(input.error) : null,
              input.idempotencyKey,
            ],
          );
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "23505"
          ) {
            throw new ExecutionRepositoryError(
              "DUPLICATE_STEP",
              "Execution step attempt already exists",
            );
          }
          throw error;
        }

        for (const output of input.outputContexts) {
          for (const sourceId of output.provenance.sourceContextIds) {
            await client.query(
              `insert into provenance_edges (
                 execution_id, from_context_id, to_context_id, node_id
               ) values ($1,$2,$3,$4)
               on conflict (execution_id, from_context_id, to_context_id, node_id)
               do nothing`,
              [input.executionId, sourceId, output.id, input.nodeId],
            );
          }
        }

        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    complete(input) {
      return terminalTransition(pool, { ...input, status: "completed" });
    },

    fail(input) {
      return terminalTransition(pool, { ...input, status: "failed" });
    },

    async cancel(executionId, finishedAt) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query(
          `update executions
              set status = 'cancelled',
                  finished_at = $2,
                  error = null
            where id = $1
              and status in ('queued','running')`,
          [executionId, finishedAt],
        );
        requireUpdated(
          result.rowCount,
          "Execution cannot be cancelled from its current state",
        );
        await insertReceipt(
          client,
          executionId,
          {
            executionId,
            status: "cancelled",
            finishedAt: finishedAt.toISOString(),
          },
          finishedAt,
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async get(ownerId, projectId, executionId): Promise<ExecutionView | null> {
      const executionResult = await pool.query<ExecutionRow>(
        `select ${EXECUTION_COLUMNS}
           from executions
          where id = $3
            and owner_id = $1
            and project_id = $2
          limit 1`,
        [ownerId, projectId, executionId],
      );
      const execution = executionResult.rows[0];
      if (!execution) return null;

      const [stepResult, provenanceResult, receiptResult] = await Promise.all([
        pool.query<ExecutionStepRow>(
          `select ${STEP_COLUMNS}
             from execution_steps
            where execution_id = $1
            order by started_at nulls first, node_id, attempt, id`,
          [executionId],
        ),
        pool.query<ProvenanceRow>(
          `select from_context_id, to_context_id, node_id
             from provenance_edges
            where execution_id = $1
            order by node_id, from_context_id, to_context_id`,
          [executionId],
        ),
        pool.query<{ receipt: ExecutionJson }>(
          "select receipt from execution_receipts where execution_id = $1",
          [executionId],
        ),
      ]);

      return {
        execution: mapExecution(execution),
        steps: stepResult.rows.map(mapStep),
        provenanceEdges: provenanceResult.rows.map(
          (row): ProvenanceEdgeRecord => ({
            fromContextId: row.from_context_id,
            toContextId: row.to_context_id,
            nodeId: row.node_id,
          }),
        ),
        receipt: receiptResult.rows[0]?.receipt ?? null,
      };
    },
  };
}
