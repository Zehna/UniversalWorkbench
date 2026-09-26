import { randomUUID } from "node:crypto";
import type { WorkflowDefinition } from "@uw/contracts";
import {
  WorkflowNotFoundError,
  WorkflowVersionConflictError,
} from "@uw/workflow";
import type { WorkflowRepository, WorkflowVersion } from "@uw/workflow";
import type { Pool, QueryResultRow } from "pg";

interface WorkflowRow extends QueryResultRow {
  id: string;
  workflow_id: string;
  version: number;
  owner_id: string;
  project_id: string;
  definition: WorkflowDefinition;
  created_at: Date;
}

function map(row: WorkflowRow): WorkflowVersion {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    version: row.version,
    ownerId: row.owner_id,
    projectId: row.project_id,
    definition: row.definition,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS =
  "w.id, w.workflow_id, w.version, w.owner_id, w.project_id, w.definition, w.created_at";

export function createPostgresWorkflowRepository(
  pool: Pool,
): WorkflowRepository {
  return {
    async list(ownerId, projectId) {
      const project = await pool.query(
        "select 1 from projects where id = $1 and owner_id = $2 and deleted_at is null",
        [projectId, ownerId],
      );
      if (project.rowCount !== 1) throw new WorkflowNotFoundError();
      const rows = await pool.query<WorkflowRow>(
        `select distinct on (w.workflow_id) ${SELECT_COLUMNS}
           from workflow_definitions w
           where w.project_id = $1 and w.owner_id = $2
           order by w.workflow_id, w.version desc`,
        [projectId, ownerId],
      );
      return rows.rows.map(map);
    },

    async get(ownerId, projectId, workflowId) {
      const result = await pool.query<WorkflowRow>(
        `select ${SELECT_COLUMNS}
           from workflow_definitions w
           join projects p on p.id = w.project_id
            and p.owner_id = w.owner_id and p.deleted_at is null
          where w.project_id = $1 and w.owner_id = $2 and w.workflow_id = $3
          order by w.version desc limit 1`,
        [projectId, ownerId, workflowId],
      );
      return result.rows[0] ? map(result.rows[0]) : null;
    },

    async save(ownerId, projectId, definition, expectedVersion) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        // Serializes every workflow version write within the project, including
        // the first version. Readers never see a partially inserted definition.
        const project = await client.query(
          "select id from projects where id = $1 and owner_id = $2 and deleted_at is null for update",
          [projectId, ownerId],
        );
        if (project.rowCount !== 1 || definition.projectId !== projectId) {
          throw new WorkflowNotFoundError();
        }
        const previous = await client.query<WorkflowRow & { matches: boolean }>(
          `select ${SELECT_COLUMNS}, (w.definition = $2::jsonb) as matches
            from workflow_definitions w
           where w.workflow_id = $1
           order by w.version desc limit 1`,
          [definition.id, JSON.stringify(definition)],
        );
        const latest = previous.rows[0];
        if (
          latest &&
          (latest.owner_id !== ownerId || latest.project_id !== projectId)
        ) {
          throw new WorkflowNotFoundError();
        }
        if (latest && latest.matches) {
          await client.query("commit");
          return map(latest);
        }
        if (
          latest &&
          (expectedVersion === undefined || expectedVersion !== latest.version)
        ) {
          throw new WorkflowVersionConflictError();
        }
        if (!latest && expectedVersion !== undefined && expectedVersion !== 0) {
          throw new WorkflowVersionConflictError();
        }
        const result = await client.query<WorkflowRow>(
          `insert into workflow_definitions
             (id, workflow_id, version, owner_id, project_id, name, schema_version, definition)
           values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
           returning id, workflow_id, version, owner_id, project_id, definition, created_at`,
          [
            randomUUID(),
            definition.id,
            (latest?.version ?? 0) + 1,
            ownerId,
            projectId,
            definition.name,
            definition.schemaVersion,
            JSON.stringify(definition),
          ],
        );
        await client.query("commit");
        return map(result.rows[0]!);
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
