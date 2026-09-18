import type { AuditRecordInput, AuditRepository } from "@uw/core";
import type { Pool } from "pg";

export function createPostgresAuditRepository(pool: Pool): AuditRepository {
  return {
    async record(input: AuditRecordInput) {
      await pool.query(
        `insert into action_audit (
           id,
           actor_id,
           project_id,
           action,
           target_type,
           target_id,
           trace_id,
           metadata,
           created_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
        [
          input.id,
          input.actorId,
          input.projectId ?? null,
          input.action,
          input.targetType,
          input.targetId ?? null,
          input.traceId,
          JSON.stringify(input.metadata),
          input.createdAt,
        ],
      );
    },
  };
}
