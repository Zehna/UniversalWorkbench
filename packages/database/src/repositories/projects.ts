import type {
  CreateProjectRecordInput,
  ProjectRepository,
  UpdateProjectRecordInput,
} from "@uw/core";
import type { Project } from "@uw/contracts";
import type { Pool, QueryResultRow } from "pg";

interface ProjectRow extends QueryResultRow {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  schema_version: number;
  created_at: Date;
  updated_at: Date;
}

const PROJECT_COLUMNS = `
  id,
  owner_id,
  name,
  description,
  schema_version,
  created_at,
  updated_at
`;

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    schemaVersion: row.schema_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function createPostgresProjectRepository(pool: Pool): ProjectRepository {
  return {
    async create(input: CreateProjectRecordInput) {
      const result = await pool.query<ProjectRow>(
        `insert into projects (
           id,
           owner_id,
           name,
           description,
           schema_version,
           created_at,
           updated_at
         ) values ($1, $2, $3, $4, 1, $5, $6)
         returning ${PROJECT_COLUMNS}`,
        [
          input.id,
          input.ownerId,
          input.name,
          input.description,
          input.createdAt,
          input.updatedAt,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Project insert returned no row");
      return mapProject(row);
    },

    async list(ownerId) {
      const result = await pool.query<ProjectRow>(
        `select ${PROJECT_COLUMNS}
           from projects
          where owner_id = $1
          order by created_at, id`,
        [ownerId],
      );
      return result.rows.map(mapProject);
    },

    async get(ownerId, projectId) {
      const result = await pool.query<ProjectRow>(
        `select ${PROJECT_COLUMNS}
           from projects
          where owner_id = $1
            and id = $2
          limit 1`,
        [ownerId, projectId],
      );
      const row = result.rows[0];
      return row ? mapProject(row) : null;
    },

    async update(
      ownerId: string,
      projectId: string,
      input: UpdateProjectRecordInput,
    ) {
      const assignments: string[] = [];
      const values: unknown[] = [ownerId, projectId];

      if (input.name !== undefined) {
        values.push(input.name);
        assignments.push(`name = $${values.length}`);
      }

      if (input.description !== undefined) {
        values.push(input.description);
        assignments.push(`description = $${values.length}`);
      }

      values.push(input.updatedAt);
      assignments.push(`updated_at = $${values.length}`);

      const result = await pool.query<ProjectRow>(
        `update projects
            set ${assignments.join(", ")}
          where owner_id = $1
            and id = $2
        returning ${PROJECT_COLUMNS}`,
        values,
      );
      const row = result.rows[0];
      return row ? mapProject(row) : null;
    },
  };
}
