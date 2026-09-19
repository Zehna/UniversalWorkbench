import type { SyncChange, SyncOperation } from "@uw/contracts";
import type { Clock } from "@uw/shared";
import type { DeviceRecord, SyncRepository } from "./repository.js";

export class SyncBatchLimitError extends Error {
  constructor() {
    super("A sync batch may contain at most 100 operations");
    this.name = "SyncBatchLimitError";
  }
}

export class SyncDeviceRejectedError extends Error {
  constructor() {
    super("Sync device is not active");
    this.name = "SyncDeviceRejectedError";
  }
}

export class SyncOperationInvalidError extends Error {
  constructor() {
    super("Sync action does not match entity type");
    this.name = "SyncOperationInvalidError";
  }
}

export interface SyncOperationApplier {
  apply(ownerId: string, operation: SyncOperation): Promise<SyncChange>;
}

export interface SyncPushResult {
  operationId: string;
  change: SyncChange;
}

export interface SyncService {
  registerDevice(
    ownerId: string,
    input: { id: string; name: string },
  ): Promise<DeviceRecord>;
  listDevices(ownerId: string): Promise<DeviceRecord[]>;
  revokeDevice(ownerId: string, deviceId: string): Promise<void>;
  listChanges(
    ownerId: string,
    cursor: string,
    limit: number,
  ): Promise<SyncChange[]>;
  getLatestCursor(ownerId: string): Promise<string>;
  pushOperations(
    ownerId: string,
    operations: SyncOperation[],
  ): Promise<SyncPushResult[]>;
}

export interface CreateSyncServiceOptions {
  repository: SyncRepository;
  applier: SyncOperationApplier;
  clock: Clock;
}

function operationMatchesEntity(operation: SyncOperation): boolean {
  if (operation.entityType === "project") {
    return operation.action.startsWith("project.");
  }
  if (operation.entityType === "document") {
    return operation.action.startsWith("document.");
  }
  return false;
}

export function createSyncService(
  options: CreateSyncServiceOptions,
): SyncService {
  const { repository, applier, clock } = options;

  return {
    registerDevice(ownerId, input) {
      return repository.registerDevice({
        id: input.id,
        ownerId,
        name: input.name,
        now: clock.now(),
      });
    },

    listDevices(ownerId) {
      return repository.listDevices(ownerId);
    },

    revokeDevice(ownerId, deviceId) {
      return repository.revokeDevice(ownerId, deviceId, clock.now());
    },

    listChanges(ownerId, cursor, limit) {
      return repository.listChanges(ownerId, cursor, limit);
    },

    getLatestCursor(ownerId) {
      return repository.getLatestCursor(ownerId);
    },

    async pushOperations(ownerId, operations) {
      if (operations.length > 100) {
        throw new SyncBatchLimitError();
      }

      for (const operation of operations) {
        if (!operationMatchesEntity(operation)) {
          throw new SyncOperationInvalidError();
        }
      }

      const activeDevices = new Set<string>();
      const results: SyncPushResult[] = [];

      for (const operation of operations) {
        if (!activeDevices.has(operation.deviceId)) {
          const device = await repository.getDevice(
            ownerId,
            operation.deviceId,
          );
          if (!device || device.revokedAt) {
            throw new SyncDeviceRejectedError();
          }
          await repository.touchDevice(
            ownerId,
            operation.deviceId,
            clock.now(),
          );
          activeDevices.add(operation.deviceId);
        }

        const change = await applier.apply(ownerId, operation);
        results.push({ operationId: operation.id, change });
      }

      return results;
    },
  };
}
