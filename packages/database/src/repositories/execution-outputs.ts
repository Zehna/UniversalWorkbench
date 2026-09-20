import { ContextEnvelopeSchema } from "@uw/contracts";
import type {
  ExecutionOutputRecord,
  ExecutionOutputRepository,
} from "@uw/execution";
import type { Pool, QueryResultRow } from "pg";

interface ExecutionOutputRow extends QueryResultRow {
  id: string;
  execution_id: string;
  step_execution_id: string;
  port_name: string;
  context_id: string;
  artifact_id: string | null;
  context: unknown;
  created_at: Date;
}

function mapRow(row: ExecutionOutputRow): ExecutionOutputRecord {
  return {
    id: row.id,
    executionId: row.execution_id,
    stepExecutionId: row.step_execution_id,
    portName: row.port_name,
    contextId: row.context_id,
    artifactId: row.artifact_id,
    context: ContextEnvelopeSchema.parse(row.context),
    createdAt: row.created_at.toISOString(),
  };
}

export function createPostgresExecutionOutputRepository(
  pool: Pool,
): ExecutionOutputRepository {
  return {
    async appendMany(records) {
      if (records.length === 0) return;
      const client = await pool.connect();
      try {
        await client.query("begin");
        for (const record of records) {
          await client.query(
            `insert into execution_outputs (
               id,
               execution_id,
               step_execution_id,
               port_name,
               context_id,
               artifact_id,
               context,
               created_at
             ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
             on conflict (step_execution_id, port_name) do nothing`,
            [
              record.id,
              record.executionId,
              record.stepExecutionId,
              record.portName,
              record.contextId,
              record.artifactId,
              JSON.stringify(record.context),
              record.createdAt,
            ],
          );
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async listByStep(stepExecutionId) {
      const result = await pool.query<ExecutionOutputRow>(
        `select
           id,
           execution_id,
           step_execution_id,
           port_name,
           context_id,
           artifact_id,
           context,
           created_at
         from execution_outputs
         where step_execution_id = $1
         order by created_at, port_name`,
        [stepExecutionId],
      );
      return result.rows.map(mapRow);
    },
  };
}
