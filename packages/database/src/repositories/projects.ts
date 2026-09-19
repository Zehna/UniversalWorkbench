import type {
  CreateProjectRecordInput,
  ProjectRepository,
  UpdateProjectRecordInput,
} from "@uw/core";
import {
  CreateProjectRequestSchema,
  UpdateProjectRequestSchema,
  type Project,
  type SyncOperation,
} from "@uw/contracts";
import type { SyncEntityApplyResult, SyncProjectStore } from "@uw/sync";
import type { Pool, QueryResultRow } from "pg";

interface ProjectRow extends QueryResultRow {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  schema_version: number;
  sync_revision: string;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const PROJECT_COLUMNS = `
  id,
  owner_id,
  name,
  description,
  schema_version,
  sync_revision,
  deleted_at,
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

function currentProjectPayload(row: ProjectRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    syncRevision: String(row.sync_revision),
    deleted: row.deleted_at !== null,
  };
}

async function currentSyncProject(
  pool: Pool,
  ownerId: string,
  projectId: string,
): Promise<ProjectRow | null> {
  const result = await pool.query<ProjectRow>(
    `select ${PROJECT_COLUMNS}
       from projects
      where owner_id = $1
        and id = $2
      limit 1`,
    [ownerId, projectId],
  );
  return result.rows[0] ?? null;
}

function conflictFromProject(row: ProjectRow | null): SyncEntityApplyResult {
  return {
    status: "conflict",
    currentRevision: row ? String(row.sync_revision) : null,
    current: row ? currentProjectPayload(row) : { missing: true },
  };
}

function parseProjectBaseRevision(operation: SyncOperation): string | null {
  return operation.baseRevision && /^(0|[1-9]\d*)$/.test(operation.baseRevision)
    ? operation.baseRevision
    : null;
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
            and deleted_at is null
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
            and deleted_at is null
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
            and deleted_at is null
        returning ${PROJECT_COLUMNS}`,
        values,
      );
      const row = result.rows[0];
      return row ? mapProject(row) : null;
    },
  };
}

export function createPostgresSyncProjectStore(pool: Pool): SyncProjectStore {
  return {
    async apply(ownerId, operation) {
      if (
        operation.entityType !== "project" ||
        !operation.action.startsWith("project.")
      ) {
        throw new Error("Project sync store received a non-project operation");
      }

      if (operation.action === "project.create") {
        const input = CreateProjectRequestSchema.parse(operation.payload);
        const createdAt = new Date(operation.createdAt);
        const inserted = await pool.query<ProjectRow>(
          `insert into projects (
             id, owner_id, name, description, schema_version,
             sync_revision, deleted_at, created_at, updated_at
           ) values ($1,$2,$3,$4,1,1,null,$5,$5)
           on conflict (id) do nothing
           returning ${PROJECT_COLUMNS}`,
          [
            operation.entityId,
            ownerId,
            input.name,
            input.description ?? null,
            createdAt,
          ],
        );
        const row = inserted.rows[0];
        if (!row) {
          return conflictFromProject(
            await currentSyncProject(pool, ownerId, operation.entityId),
          );
        }
        return {
          status: "applied",
          kind: "upsert",
          revision: String(row.sync_revision),
          payload: { project: mapProject(row) },
        };
      }

      const baseRevision = parseProjectBaseRevision(operation);
      if (baseRevision === null) {
        return conflictFromProject(
          await currentSyncProject(pool, ownerId, operation.entityId),
        );
      }

      if (operation.action === "project.delete") {
        const deleted = await pool.query<ProjectRow>(
          `update projects
              set deleted_at = now(),
                  updated_at = now(),
                  sync_revision = sync_revision + 1
            where owner_id = $1
              and id = $2
              and deleted_at is null
              and sync_revision = $3::bigint
          returning ${PROJECT_COLUMNS}`,
          [ownerId, operation.entityId, baseRevision],
        );
        const row = deleted.rows[0];
        if (!row) {
          return conflictFromProject(
            await currentSyncProject(pool, ownerId, operation.entityId),
          );
        }
        return {
          status: "applied",
          kind: "tombstone",
          revision: null,
          payload: { id: row.id, deleted: true },
        };
      }

      const input = UpdateProjectRequestSchema.parse(operation.payload);
      const assignments = [
        "sync_revision = sync_revision + 1",
        "updated_at = now()",
      ];
      const values: unknown[] = [ownerId, operation.entityId, baseRevision];

      if (input.name !== undefined) {
        values.push(input.name);
        assignments.push(`name = $${values.length}`);
      }
      if (input.description !== undefined) {
        values.push(input.description);
        assignments.push(`description = $${values.length}`);
      }

      const updated = await pool.query<ProjectRow>(
        `update projects
            set ${assignments.join(", ")}
          where owner_id = $1
            and id = $2
            and deleted_at is null
            and sync_revision = $3::bigint
        returning ${PROJECT_COLUMNS}`,
        values,
      );
      const row = updated.rows[0];
      if (!row) {
        return conflictFromProject(
          await currentSyncProject(pool, ownerId, operation.entityId),
        );
      }
      return {
        status: "applied",
        kind: "upsert",
        revision: String(row.sync_revision),
        payload: { project: mapProject(row) },
      };
    },
  };
}
