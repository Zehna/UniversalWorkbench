import type { ProvenanceEdge, ProvenanceRepository } from "@uw/execution";
import type { Pool, QueryResultRow } from "pg";

interface ProvenanceRow extends QueryResultRow {
  id: string;
  project_id: string;
  execution_id: string;
  step_execution_id: string | null;
  source_kind: "context" | "artifact";
  source_id: string;
  target_kind: "context" | "artifact";
  target_id: string;
  relation: string;
  created_at: Date;
}

function mapProvenance(row: ProvenanceRow): ProvenanceEdge {
  return {
    id: row.id,
    projectId: row.project_id,
    executionId: row.execution_id,
    stepExecutionId: row.step_execution_id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    relation: row.relation,
    createdAt: row.created_at.toISOString(),
  };
}

export function createPostgresProvenanceRepository(
  pool: Pool,
): ProvenanceRepository {
  return {
    async append(edge) {
      await pool.query(
        `insert into provenance_edges (
           id,
           project_id,
           execution_id,
           step_execution_id,
           source_kind,
           source_id,
           target_kind,
           target_id,
           relation,
           created_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          edge.id,
          edge.projectId,
          edge.executionId,
          edge.stepExecutionId,
          edge.sourceKind,
          edge.sourceId,
          edge.targetKind,
          edge.targetId,
          edge.relation,
          edge.createdAt,
        ],
      );
    },

    async listByExecution(executionId) {
      const result = await pool.query<ProvenanceRow>(
        `select
           id,
           project_id,
           execution_id,
           step_execution_id,
           source_kind,
           source_id,
           target_kind,
           target_id,
           relation,
           created_at
         from provenance_edges
        where execution_id = $1
        order by created_at, id`,
        [executionId],
      );
      return result.rows.map(mapProvenance);
    },
  };
}
