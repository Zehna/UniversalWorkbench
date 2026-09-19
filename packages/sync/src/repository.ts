import type {
  SyncChange,
  SyncEntityType,
  SyncOperation,
} from "@uw/contracts";

export interface DeviceRecord {
  id: string;
  ownerId: string;
  name: string;
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

export interface StoredSyncOperation {
  ownerId: string;
  operation: SyncOperation;
  outcome: "applied" | "conflict";
  resultRevision: string | null;
}

export interface SyncTombstoneRecord {
  cursor: string;
}

export interface PersistAppliedOperationInput {
  ownerId: string;
  operation: SyncOperation;
  resultRevision: string | null;
  change: {
    kind: "upsert" | "tombstone";
    revision: string | null;
    payload: Record<string, unknown>;
  };
  now: Date;
}

export interface PersistConflictInput {
  ownerId: string;
  operation: SyncOperation;
  currentRevision: string | null;
  change: {
    kind: "conflict";
    revision: string | null;
    payload: Record<string, unknown>;
  };
  now: Date;
}

export interface SyncRepository {
  registerDevice(input: {
    id: string;
    ownerId: string;
    name: string;
    now: Date;
  }): Promise<DeviceRecord>;
  listDevices(ownerId: string): Promise<DeviceRecord[]>;
  getDevice(ownerId: string, deviceId: string): Promise<DeviceRecord | null>;
  touchDevice(ownerId: string, deviceId: string, now: Date): Promise<void>;
  revokeDevice(ownerId: string, deviceId: string, now: Date): Promise<void>;
  findOperation(
    ownerId: string,
    operationId: string,
  ): Promise<StoredSyncOperation | null>;
  findChange(ownerId: string, operationId: string): Promise<SyncChange | null>;
  findTombstone(
    ownerId: string,
    entityType: SyncEntityType,
    entityId: string,
  ): Promise<SyncTombstoneRecord | null>;
  persistAppliedOperation(
    input: PersistAppliedOperationInput,
  ): Promise<SyncChange>;
  persistConflict(input: PersistConflictInput): Promise<SyncChange>;
  listChanges(
    ownerId: string,
    afterCursor: string,
    limit: number,
  ): Promise<SyncChange[]>;
  getLatestCursor(ownerId: string): Promise<string>;
}
