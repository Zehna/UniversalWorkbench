import { describe, expect, it } from "vitest";
import type { SyncChange, SyncOperation } from "@uw/contracts";
import {
  createSyncOperationApplier,
  type SyncDocumentStore,
  type SyncProjectStore,
  type SyncRepository,
} from "../src/index.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const DOCUMENT_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-09-19T08:00:00.000Z");

function operation(overrides: Partial<SyncOperation> = {}): SyncOperation {
  return {
    id: crypto.randomUUID(),
    deviceId: DEVICE_ID,
    projectId: PROJECT_ID,
    entityType: "project",
    entityId: PROJECT_ID,
    action: "project.update",
    baseRevision: "1",
    payload: { name: "Offline project" },
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function createHarness() {
  let cursor = 0n;
  const changes = new Map<string, SyncChange>();
  const tombstones = new Map<string, { cursor: string }>();
  const audits: string[] = [];

  const repository: SyncRepository = {
    registerDevice: async () => {
      throw new Error("not used");
    },
    listDevices: async () => [],
    getDevice: async () => null,
    touchDevice: async () => undefined,
    revokeDevice: async () => undefined,
    findOperation: async () => null,
    findChange: async (_ownerId, operationId) =>
      changes.get(operationId) ?? null,
    findTombstone: async (_ownerId, entityType, entityId) =>
      tombstones.get(`${entityType}:${entityId}`) ?? null,
    persistAppliedOperation: async (input) => {
      const existing = changes.get(input.operation.id);
      if (existing) return existing;
      cursor += 1n;
      const change: SyncChange = {
        cursor: cursor.toString(),
        operationId: input.operation.id,
        entityType: input.operation.entityType,
        entityId: input.operation.entityId,
        kind: input.change.kind,
        revision: input.change.revision,
        payload: input.change.payload,
        createdAt: input.now.toISOString(),
      };
      changes.set(input.operation.id, change);
      if (change.kind === "tombstone") {
        tombstones.set(
          `${input.operation.entityType}:${input.operation.entityId}`,
          { cursor: change.cursor },
        );
      }
      return change;
    },
    persistConflict: async (input) => {
      const existing = changes.get(input.operation.id);
      if (existing) return existing;
      cursor += 1n;
      const change: SyncChange = {
        cursor: cursor.toString(),
        operationId: input.operation.id,
        entityType: input.operation.entityType,
        entityId: input.operation.entityId,
        kind: "conflict",
        revision: input.change.revision,
        payload: input.change.payload,
        createdAt: input.now.toISOString(),
      };
      changes.set(input.operation.id, change);
      return change;
    },
    listChanges: async () => [],
    getLatestCursor: async () => cursor.toString(),
  };

  let projectApplyCount = 0;
  const projects: SyncProjectStore = {
    async apply(_ownerId, syncOperation) {
      projectApplyCount += 1;
      if (syncOperation.action === "project.delete") {
        return {
          status: "applied",
          kind: "tombstone",
          revision: null,
          payload: { id: syncOperation.entityId, deleted: true },
        };
      }
      return {
        status: "applied",
        kind: "upsert",
        revision: "2",
        payload: {
          id: syncOperation.entityId,
          name: String(syncOperation.payload.name ?? "Project"),
        },
      };
    },
  };

  let documentBody = "server body";
  const documents: SyncDocumentStore = {
    async apply(_ownerId, syncOperation) {
      if (
        syncOperation.action === "document.update" &&
        syncOperation.baseRevision !== "server-revision"
      ) {
        return {
          status: "conflict",
          currentRevision: "server-revision",
          current: { title: "Note", body: documentBody },
        };
      }
      documentBody = String(syncOperation.payload.body ?? documentBody);
      return {
        status: "applied",
        kind:
          syncOperation.action === "document.delete" ? "tombstone" : "upsert",
        revision:
          syncOperation.action === "document.delete"
            ? null
            : "next-server-revision",
        payload: {
          id: syncOperation.entityId,
          title: String(syncOperation.payload.title ?? "Note"),
          body: documentBody,
        },
      };
    },
  };

  const applier = createSyncOperationApplier({
    repository,
    projects,
    documents,
    audit: {
      record: async (input) => {
        audits.push(input.action);
      },
    },
    clock: { now: () => NOW },
    idGenerator: { next: () => crypto.randomUUID() },
  });

  return {
    applier,
    audits,
    getProjectApplyCount: () => projectApplyCount,
    getDocumentBody: () => documentBody,
  };
}

describe("sync operation apply engine", () => {
  it("ACKs the same operation ID without applying twice", async () => {
    const harness = createHarness();
    const syncOperation = operation();

    const first = await harness.applier.apply(OWNER_ID, syncOperation);
    const replay = await harness.applier.apply(OWNER_ID, syncOperation);

    expect(replay).toEqual(first);
    expect(harness.getProjectApplyCount()).toBe(1);
    expect(harness.audits).toEqual(["sync.project.update"]);
  });

  it("preserves both note versions on stale base revision", async () => {
    const harness = createHarness();
    const syncOperation = operation({
      entityType: "document",
      entityId: DOCUMENT_ID,
      action: "document.update",
      baseRevision: "offline-base",
      payload: { title: "Note", body: "offline body" },
    });

    const result = await harness.applier.apply(OWNER_ID, syncOperation);

    expect(result.kind).toBe("conflict");
    expect(result.payload).toEqual({
      incoming: syncOperation.payload,
      current: { title: "Note", body: "server body" },
    });
    expect(harness.getDocumentBody()).toBe("server body");
    expect(harness.audits).toEqual([]);
  });

  it("does not resurrect an entity after its tombstone", async () => {
    const harness = createHarness();
    await harness.applier.apply(
      OWNER_ID,
      operation({
        action: "project.delete",
        payload: {},
      }),
    );

    const beforeReplay = harness.getProjectApplyCount();
    const staleUpdate = operation({
      baseRevision: "1",
      payload: { name: "Resurrected" },
    });
    const result = await harness.applier.apply(OWNER_ID, staleUpdate);

    expect(result.kind).toBe("conflict");
    expect(result.payload).toMatchObject({
      incoming: staleUpdate.payload,
      current: { deleted: true },
    });
    expect(harness.getProjectApplyCount()).toBe(beforeReplay);
  });
});
