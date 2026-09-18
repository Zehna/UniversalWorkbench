import type {
  ArtifactRepository,
  CreateArtifactRecordInput,
} from "@uw/artifacts";
import type { Artifact } from "@uw/contracts";
import type { Pool, QueryResultRow } from "pg";

interface ArtifactRow extends QueryResultRow {
  id: string;
  project_id: string;
  type: string;
  schema_version: number;
  mime_type: string;
  checksum_sha256: string;
  size_bytes: string | number;
  storage_key: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

function mapArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    schemaVersion: row.schema_version,
    mimeType: row.mime_type,
    checksumSha256: row.checksum_sha256,
    sizeBytes: Number(row.size_bytes),
    storageKey: row.storage_key,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
  };
}

export function createPostgresArtifactRepository(
  pool: Pool,
): ArtifactRepository {
  return {
    async projectExists(ownerId, projectId) {
      const result = await pool.query(
        `select 1
           from projects
          where id = $1
            and owner_id = $2
          limit 1`,
        [projectId, ownerId],
      );
      return result.rowCount === 1;
    },

    async create(input: CreateArtifactRecordInput) {
      const result = await pool.query<ArtifactRow>(
        `insert into artifacts (
           id,
           project_id,
           type,
           schema_version,
           mime_type,
           checksum_sha256,
           size_bytes,
           storage_key,
           metadata,
           created_at
         )
         select
           $1,
           p.id,
           $4,
           $5,
           $6,
           $7,
           $8,
           $9,
           $10,
           $11
         from projects p
         where p.id = $2
           and p.owner_id = $3
         returning
           id,
           project_id,
           type,
           schema_version,
           mime_type,
           checksum_sha256,
           size_bytes,
           storage_key,
           metadata,
           created_at`,
        [
          input.id,
          input.projectId,
          input.ownerId,
          input.type,
          input.schemaVersion,
          input.mimeType,
          input.checksumSha256,
          input.sizeBytes,
          input.storageKey,
          input.metadata,
          input.createdAt,
        ],
      );
      const row = result.rows[0];
      return row ? mapArtifact(row) : null;
    },

    async list(ownerId, projectId) {
      const result = await pool.query<ArtifactRow>(
        `select
           a.id,
           a.project_id,
           a.type,
           a.schema_version,
           a.mime_type,
           a.checksum_sha256,
           a.size_bytes,
           a.storage_key,
           a.metadata,
           a.created_at
         from artifacts a
         join projects p on p.id = a.project_id
        where p.owner_id = $1
          and a.project_id = $2
        order by a.created_at, a.id`,
        [ownerId, projectId],
      );
      return result.rows.map(mapArtifact);
    },

    async get(ownerId, projectId, artifactId) {
      const result = await pool.query<ArtifactRow>(
        `select
           a.id,
           a.project_id,
           a.type,
           a.schema_version,
           a.mime_type,
           a.checksum_sha256,
           a.size_bytes,
           a.storage_key,
           a.metadata,
           a.created_at
         from artifacts a
         join projects p on p.id = a.project_id
        where p.owner_id = $1
          and a.project_id = $2
          and a.id = $3
        limit 1`,
        [ownerId, projectId, artifactId],
      );
      const row = result.rows[0];
      return row ? mapArtifact(row) : null;
    },
  };
}
