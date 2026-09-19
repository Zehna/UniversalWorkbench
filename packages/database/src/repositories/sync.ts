import type { SyncChange, SyncOperation } from "@uw/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  DeviceRecord,
  StoredSyncOperation,
  SyncRepository,
} from "@uw/sync";

interface DeviceRow extends QueryResultRow {
  id: string;
  owner_id: string;
  name: string;
  created_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
}

interface OperationRow extends QueryResultRow {
  id: string;
  owner_id: string;
  device_id: string;
  project_id: string | null;
  entity_type: SyncOperation["entityType"];
  entity_id: string;
  action: SyncOperation["action"];
  base_revision: string | null;
  payload: Record<string, unknown>;
  outcome: "applied" | "conflict";
  result_revision: string | null;
  created_at: Date;
}

interface ChangeRow extends QueryResultRow {
  cursor: string;
  operation_id: string;
  entity_type: SyncChange["entityType"];
  entity_id: string;
  kind: SyncChange["kind"];
  revision: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

function mapDevice(row: DeviceRow): DeviceRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

function mapOperation(row: OperationRow): StoredSyncOperation {
  return {
    ownerId: row.owner_id,
    operation: {
      id: row.id,
      deviceId: row.device_id,
      projectId: row.project_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      action: row.action,
      baseRevision: row.base_revision,
      payload: row.payload,
      createdAt: row.created_at.toISOString(),
    },
    outcome: row.outcome,
    resultRevision: row.result_revision,
  };
}

function mapChange(row: ChangeRow): SyncChange {
  return {
    cursor: String(row.cursor),
    operationId: row.operation_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    kind: row.kind,
    revision: row.revision,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  };
}

const CHANGE_COLUMNS = `
  cursor,
  operation_id,
  entity_type,
  entity_id,
  kind,
  revision,
  payload,
  created_at
`;

async function findChange(
  client: Pool | PoolClient,
  ownerId: string,
  operationId: string,
): Promise<SyncChange | null> {
  const result = await client.query<ChangeRow>(
    `select ${CHANGE_COLUMNS}
       from sync_changes
      where owner_id = $1
        and operation_id = $2
      limit 1`,
    [ownerId, operationId],
  );
  const row = result.rows[0];
  return row ? mapChange(row) : null;
}

async function persistOutcome(
  pool: Pool,
  input: {
    ownerId: string;
    operation: SyncOperation;
    outcome: "applied" | "conflict";
    resultRevision: string | null;
    change: {
      kind: SyncChange["kind"];
      revision: string | null;
      payload: Record<string, unknown>;
    };
    now: Date;
  },
): Promise<SyncChange> {
  const existing = await findChange(pool, input.ownerId, input.operation.id);
  if (existing) return existing;

  const client = await pool.connect();
  try {
    await client.query("begin");

    const insertedOperation = await client.query<{ id: string }>(
      `insert into sync_operations (
         id, owner_id, device_id, project_id, entity_type, entity_id,
         action, base_revision, payload, outcome, result_revision, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
       on conflict (id) do nothing
       returning id`,
      [
        input.operation.id,
        input.ownerId,
        input.operation.deviceId,
        input.operation.projectId,
        input.operation.entityType,
        input.operation.entityId,
        input.operation.action,
        input.operation.baseRevision,
        JSON.stringify(input.operation.payload),
        input.outcome,
        input.resultRevision,
        new Date(input.operation.createdAt),
      ],
    );

    if (!insertedOperation.rows[0]) {
      const replay = await findChange(
        client,
        input.ownerId,
        input.operation.id,
      );
      if (!replay) {
        throw new Error("Sync operation exists without a persisted change");
      }
      await client.query("commit");
      return replay;
    }

    const insertedChange = await client.query<ChangeRow>(
      `insert into sync_changes (
         owner_id, operation_id, entity_type, entity_id,
         kind, revision, payload, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       returning ${CHANGE_COLUMNS}`,
      [
        input.ownerId,
        input.operation.id,
        input.operation.entityType,
        input.operation.entityId,
        input.change.kind,
        input.change.revision,
        JSON.stringify(input.change.payload),
        input.now,
      ],
    );
    const row = insertedChange.rows[0];
    if (!row) throw new Error("Sync change insert returned no row");
    const change = mapChange(row);

    if (input.change.kind === "tombstone") {
      await client.query(
        `insert into sync_tombstones (
           owner_id, entity_type, entity_id, project_id,
           operation_id, cursor, deleted_at
         ) values ($1,$2,$3,$4,$5,$6::bigint,$7)
         on conflict (owner_id, entity_type, entity_id)
         do update set
           project_id = excluded.project_id,
           operation_id = excluded.operation_id,
           cursor = excluded.cursor,
           deleted_at = excluded.deleted_at`,
        [
          input.ownerId,
          input.operation.entityType,
          input.operation.entityId,
          input.operation.projectId,
          input.operation.id,
          change.cursor,
          input.now,
        ],
      );
    }

    await client.query("commit");
    return change;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function createPostgresSyncRepository(pool: Pool): SyncRepository {
  return {
    async registerDevice(input) {
      const result = await pool.query<DeviceRow>(
        `insert into sync_devices (
           id, owner_id, name, created_at, last_seen_at, revoked_at
         ) values ($1,$2,$3,$4,$4,null)
         on conflict (id) do update set
           name = excluded.name,
           last_seen_at = excluded.last_seen_at
         where sync_devices.owner_id = excluded.owner_id
         returning id, owner_id, name, created_at, last_seen_at, revoked_at`,
        [input.id, input.ownerId, input.name, input.now],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Device ID belongs to another owner");
      return mapDevice(row);
    },

    async listDevices(ownerId) {
      const result = await pool.query<DeviceRow>(
        `select id, owner_id, name, created_at, last_seen_at, revoked_at
           from sync_devices
          where owner_id = $1
          order by created_at asc, id asc`,
        [ownerId],
      );
      return result.rows.map(mapDevice);
    },

    async getDevice(ownerId, deviceId) {
      const result = await pool.query<DeviceRow>(
        `select id, owner_id, name, created_at, last_seen_at, revoked_at
           from sync_devices
          where owner_id = $1 and id = $2
          limit 1`,
        [ownerId, deviceId],
      );
      const row = result.rows[0];
      return row ? mapDevice(row) : null;
    },

    async touchDevice(ownerId, deviceId, now) {
      await pool.query(
        `update sync_devices set last_seen_at = $3
          where owner_id = $1 and id = $2`,
        [ownerId, deviceId, now],
      );
    },

    async revokeDevice(ownerId, deviceId, now) {
      await pool.query(
        `update sync_devices set revoked_at = coalesce(revoked_at, $3)
          where owner_id = $1 and id = $2`,
        [ownerId, deviceId, now],
      );
    },

    async findOperation(ownerId, operationId) {
      const result = await pool.query<OperationRow>(
        `select id, owner_id, device_id, project_id, entity_type, entity_id,
                action, base_revision, payload, outcome, result_revision, created_at
           from sync_operations
          where owner_id = $1 and id = $2
          limit 1`,
        [ownerId, operationId],
      );
      const row = result.rows[0];
      return row ? mapOperation(row) : null;
    },

    persistAppliedOperation(input) {
      return persistOutcome(pool, {
        ownerId: input.ownerId,
        operation: input.operation,
        outcome: "applied",
        resultRevision: input.resultRevision,
        change: input.change,
        now: input.now,
      });
    },

    persistConflict(input) {
      return persistOutcome(pool, {
        ownerId: input.ownerId,
        operation: input.operation,
        outcome: "conflict",
        resultRevision: input.currentRevision,
        change: input.change,
        now: input.now,
      });
    },

    async listChanges(ownerId, afterCursor, limit) {
      const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
      const result = await pool.query<ChangeRow>(
        `select ${CHANGE_COLUMNS}
           from sync_changes
          where owner_id = $1 and cursor > $2::bigint
          order by cursor asc
          limit $3`,
        [ownerId, afterCursor, safeLimit],
      );
      return result.rows.map(mapChange);
    },

    async getLatestCursor(ownerId) {
      const result = await pool.query<{ cursor: string }>(
        `select coalesce(max(cursor), 0)::text as cursor
           from sync_changes
          where owner_id = $1`,
        [ownerId],
      );
      return result.rows[0]?.cursor ?? "0";
    },
  };
}
