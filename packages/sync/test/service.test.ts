import { describe, expect, it, vi } from "vitest";
import type { SyncChange, SyncOperation } from "@uw/contracts";
import {
  SyncBatchLimitError,
  SyncDeviceRejectedError,
  SyncOperationInvalidError,
  createSyncService,
  type DeviceRecord,
  type SyncOperationApplier,
  type SyncRepository,
} from "../src/index.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-09-19T00:00:00.000Z");

function device(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: DEVICE_ID,
    ownerId: OWNER_ID,
    name: "Browser",
    createdAt: NOW,
    lastSeenAt: NOW,
    revokedAt: null,
    ...overrides,
  };
}

function operation(overrides: Partial<SyncOperation> = {}): SyncOperation {
  return {
    id: crypto.randomUUID(),
    deviceId: DEVICE_ID,
    projectId: PROJECT_ID,
    entityType: "project",
    entityId: PROJECT_ID,
    action: "project.update",
    baseRevision: "1",
    payload: { name: "Offline" },
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function change(op: SyncOperation): SyncChange {
  return {
    cursor: "7",
    operationId: op.id,
    entityType: op.entityType,
    entityId: op.entityId,
    kind: "upsert",
    revision: "2",
    payload: op.payload,
    createdAt: NOW.toISOString(),
  };
}

function createHarness(record: DeviceRecord | null = device()) {
  const repository: SyncRepository = {
    registerDevice: vi.fn(async (input) =>
      device({ id: input.id, name: input.name }),
    ),
    listDevices: vi.fn(async () => (record ? [record] : [])),
    getDevice: vi.fn(async () => record),
    touchDevice: vi.fn(async () => undefined),
    revokeDevice: vi.fn(async () => undefined),
    findOperation: vi.fn(async () => null),
    persistAppliedOperation: vi.fn(),
    persistConflict: vi.fn(),
    listChanges: vi.fn(async () => []),
    getLatestCursor: vi.fn(async () => "0"),
  };
  const applier: SyncOperationApplier = {
    apply: vi.fn(async (_ownerId, op) => change(op)),
  };
  const service = createSyncService({
    repository,
    applier,
    clock: { now: () => NOW },
  });
  return { service, repository, applier };
}

describe("SyncService", () => {
  it("registers, lists, and revokes devices for the trusted owner", async () => {
    const { service, repository } = createHarness();
    await service.registerDevice(OWNER_ID, { id: DEVICE_ID, name: "Phone" });
    await service.listDevices(OWNER_ID);
    await service.revokeDevice(OWNER_ID, DEVICE_ID);

    expect(repository.registerDevice).toHaveBeenCalledWith({
      id: DEVICE_ID,
      ownerId: OWNER_ID,
      name: "Phone",
      now: NOW,
    });
    expect(repository.listDevices).toHaveBeenCalledWith(OWNER_ID);
    expect(repository.revokeDevice).toHaveBeenCalledWith(
      OWNER_ID,
      DEVICE_ID,
      NOW,
    );
  });

  it("rejects operations from unknown or revoked devices", async () => {
    const unknown = createHarness(null);
    await expect(
      unknown.service.pushOperations(OWNER_ID, [operation()]),
    ).rejects.toBeInstanceOf(SyncDeviceRejectedError);

    const revoked = createHarness(device({ revokedAt: NOW }));
    await expect(
      revoked.service.pushOperations(OWNER_ID, [operation()]),
    ).rejects.toBeInstanceOf(SyncDeviceRejectedError);

    expect(unknown.applier.apply).not.toHaveBeenCalled();
    expect(revoked.applier.apply).not.toHaveBeenCalled();
  });

  it("rejects action and entity mismatches before repository mutation", async () => {
    const { service, repository, applier } = createHarness();
    const invalid = operation({
      entityType: "document",
      action: "project.update",
    });

    await expect(
      service.pushOperations(OWNER_ID, [invalid]),
    ).rejects.toBeInstanceOf(SyncOperationInvalidError);
    expect(repository.getDevice).not.toHaveBeenCalled();
    expect(applier.apply).not.toHaveBeenCalled();
  });

  it("bounds operation batches at 100", async () => {
    const { service, applier } = createHarness();
    const operations = Array.from({ length: 101 }, () => operation());

    await expect(
      service.pushOperations(OWNER_ID, operations),
    ).rejects.toBeInstanceOf(SyncBatchLimitError);
    expect(applier.apply).not.toHaveBeenCalled();
  });

  it("touches active devices and applies operations in order", async () => {
    const { service, repository, applier } = createHarness();
    const first = operation();
    const second = operation();

    const result = await service.pushOperations(OWNER_ID, [first, second]);

    expect(result.map((item) => item.operationId)).toEqual([
      first.id,
      second.id,
    ]);
    expect(repository.touchDevice).toHaveBeenCalledWith(
      OWNER_ID,
      DEVICE_ID,
      NOW,
    );
    expect(applier.apply).toHaveBeenNthCalledWith(1, OWNER_ID, first);
    expect(applier.apply).toHaveBeenNthCalledWith(2, OWNER_ID, second);
  });

  it("delegates bounded cursor catch-up to the repository", async () => {
    const { service, repository } = createHarness();
    await service.listChanges(OWNER_ID, "12", 500);
    expect(repository.listChanges).toHaveBeenCalledWith(OWNER_ID, "12", 500);
  });
});
