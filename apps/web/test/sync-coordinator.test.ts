import { describe, expect, it, vi } from "vitest";
import type {
  NoteDocumentView,
  Project,
  ServerSyncMessage,
  SyncChange,
  SyncOperation,
  UpdateNoteRequest,
  WorkflowDocumentView,
} from "@uw/contracts";
import type {
  LocalConflictRecord,
  LocalDeviceRecord,
  LocalStore,
  LocalTransaction,
} from "../src/local/store";
import {
  createSyncCoordinator,
  type SyncNetworkClient,
} from "../src/sync/coordinator";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const DOCUMENT_ID = "44444444-4444-4444-8444-444444444444";
const REVISION_ID = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-09-19T00:00:00.000Z";

const device: LocalDeviceRecord = {
  id: DEVICE_ID,
  ownerId: OWNER_ID,
  label: "Browser",
  createdAt: NOW,
};

function project(): Project {
  return {
    id: PROJECT_ID,
    ownerId: OWNER_ID,
    name: "Research",
    description: null,
    schemaVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function note(body = "server copy"): NoteDocumentView {
  return {
    document: {
      id: DOCUMENT_ID,
      projectId: PROJECT_ID,
      kind: "note",
      title: "Sources",
      currentRevisionId: REVISION_ID,
      createdAt: NOW,
      updatedAt: NOW,
    },
    revision: {
      id: REVISION_ID,
      documentId: DOCUMENT_ID,
      revisionNumber: 1,
      parentRevisionId: null,
      content: { body },
      metadata: {},
      createdAt: NOW,
    },
  };
}

class MemoryStore implements LocalStore {
  readonly backend = "indexeddb" as const;
  private storedDevice: LocalDeviceRecord | null = device;
  private cursor = "0";
  private projects = new Map<string, Project>();
  private notes = new Map<string, NoteDocumentView>();
  private workflows = new Map<string, WorkflowDocumentView>();
  private pending = new Map<string, SyncOperation>();
  private conflicts = new Map<string, LocalConflictRecord>();

  async transaction<T>(fn: (tx: LocalTransaction) => Promise<T>): Promise<T> {
    const projects = new Map(this.projects);
    const notes = new Map(this.notes);
    const workflows = new Map(this.workflows);
    const pending = new Map(this.pending);

    const tx: LocalTransaction = {
      async upsertProject(value) {
        projects.set(value.id, structuredClone(value));
      },
      async upsertNote(value) {
        notes.set(value.document.id, structuredClone(value));
      },
      async upsertWorkflow(value) {
        workflows.set(value.document.id, structuredClone(value));
      },
      async putTombstone() {},
      async appendOperation(operation) {
        pending.set(operation.id, structuredClone(operation));
      },
    };

    const result = await fn(tx);
    this.projects = projects;
    this.notes = notes;
    this.workflows = workflows;
    this.pending = pending;
    return result;
  }

  async getDevice() {
    return this.storedDevice ? structuredClone(this.storedDevice) : null;
  }

  async setDevice(value: LocalDeviceRecord) {
    this.storedDevice = structuredClone(value);
  }

  async getCursor() {
    return this.cursor;
  }

  async setCursor(cursor: string) {
    this.cursor = cursor;
  }

  async listProjects() {
    return [...this.projects.values()].map((value) => structuredClone(value));
  }

  async listNotes(projectId: string) {
    return [...this.notes.values()]
      .filter((value) => value.document.projectId === projectId)
      .map((value) => structuredClone(value));
  }

  async getNote(documentId: string) {
    const value = this.notes.get(documentId);
    return value ? structuredClone(value) : null;
  }

  async listWorkflows(projectId: string) {
    return [...this.workflows.values()]
      .filter((value) => value.document.projectId === projectId)
      .map((value) => structuredClone(value));
  }

  async getWorkflow(documentId: string) {
    const value = this.workflows.get(documentId);
    return value ? structuredClone(value) : null;
  }

  async listPendingOperations(limit: number) {
    return [...this.pending.values()]
      .slice(0, limit)
      .map((value) => structuredClone(value));
  }

  async markOperationAcked(operationId: string, cursor: string) {
    this.pending.delete(operationId);
    this.cursor = cursor;
  }

  async applyRemoteChange(change: SyncChange) {
    if (change.kind === "conflict") {
      this.conflicts.set(change.operationId, {
        operationId: change.operationId,
        change: structuredClone(change),
        createdAt: change.createdAt,
      });
      this.cursor = change.cursor;
      return;
    }

    if (change.entityType === "project" && change.kind === "upsert") {
      const value = change.payload.project as Project | undefined;
      if (value) this.projects.set(value.id, structuredClone(value));
    }

    if (change.entityType === "document" && change.kind === "upsert") {
      const value = change.payload.note as NoteDocumentView | undefined;
      const workflow = change.payload.workflow as
        import("@uw/contracts").WorkflowDocumentView | undefined;
      if (value) this.notes.set(value.document.id, structuredClone(value));
      if (workflow) {
        this.workflows.set(workflow.document.id, structuredClone(workflow));
      }
    }

    this.cursor = change.cursor;
  }

  async listConflicts() {
    return [...this.conflicts.values()].map((value) => structuredClone(value));
  }

  async clearConflict(operationId: string) {
    this.conflicts.delete(operationId);
    this.pending.delete(operationId);
  }

  async close() {}

  async seedProject(value: Project) {
    this.projects.set(value.id, structuredClone(value));
  }

  async seedNote(value: NoteDocumentView) {
    this.notes.set(value.document.id, structuredClone(value));
  }
}

function network(
  overrides: Partial<SyncNetworkClient> = {},
): SyncNetworkClient {
  let cursor = 0;
  return {
    registerDevice: vi.fn().mockResolvedValue(undefined),
    listChanges: vi.fn().mockResolvedValue([]),
    pushOperations: vi
      .fn()
      .mockImplementation(async (operations: SyncOperation[]) =>
        operations.map((operation) => ({
          operationId: operation.id,
          change: {
            cursor: String(++cursor),
            operationId: operation.id,
            entityType: operation.entityType,
            entityId: operation.entityId,
            kind: "upsert" as const,
            revision: "1",
            payload: {},
            createdAt: NOW,
          },
        })),
      ),
    connect: vi.fn().mockReturnValue({
      close() {},
      state() {
        return "open" as const;
      },
    }),
    ...overrides,
  };
}

describe("browser sync coordinator", () => {
  it("reports non-secret sync diagnostics", async () => {
    const store = new MemoryStore();
    const coordinator = createSyncCoordinator({
      ownerId: OWNER_ID,
      store,
      client: network(),
    });

    await coordinator.start();
    expect(await coordinator.diagnostics()).toMatchObject({
      deviceId: DEVICE_ID,
      backend: "indexeddb",
      cursor: "0",
      pendingOperations: 0,
      conflicts: 0,
      websocketState: "open",
      lastErrorCode: null,
    });

    await coordinator.stop();
  });

  it("keeps a local save successful when the network is offline", async () => {
    const store = new MemoryStore();
    await store.seedProject(project());
    const original = note("original");
    await store.seedNote(original);

    const client = network({
      pushOperations: vi.fn().mockRejectedValue(new Error("offline")),
    });
    const coordinator = createSyncCoordinator({
      ownerId: OWNER_ID,
      store,
      client,
    });
    await coordinator.start();

    const input: UpdateNoteRequest = {
      title: "Sources",
      body: "offline edit",
      baseRevisionId: original.revision.id,
    };
    const saved = await coordinator.updateNote(original, input);

    expect(saved.revision.content.body).toBe("offline edit");
    expect((await store.getNote(DOCUMENT_ID))?.revision.content.body).toBe(
      "offline edit",
    );
    expect(coordinator.status()).toMatchObject({
      state: "offline",
      pending: 1,
    });

    await coordinator.stop();
  });

  it("does not delete local text when the server reports a conflict", async () => {
    const store = new MemoryStore();
    await store.seedProject(project());
    const original = note("original");
    await store.seedNote(original);

    const coordinator = createSyncCoordinator({
      ownerId: OWNER_ID,
      store,
      client: network({
        pushOperations: vi.fn().mockRejectedValue(new Error("offline")),
      }),
    });
    await coordinator.start();

    const saved = await coordinator.updateNote(original, {
      title: "Sources",
      body: "my offline edit",
      baseRevisionId: original.revision.id,
    });
    const [pending] = await store.listPendingOperations(10);
    expect(pending).toBeDefined();

    const conflict: SyncChange = {
      cursor: "9",
      operationId: pending!.id,
      entityType: "document",
      entityId: DOCUMENT_ID,
      kind: "conflict",
      revision: "server-revision-2",
      payload: {
        incoming: { title: "Sources", body: "my offline edit" },
        current: {
          title: "Sources",
          body: "server edit",
          currentRevisionId: "66666666-6666-4666-8666-666666666666",
        },
      },
      createdAt: NOW,
    };
    const message: ServerSyncMessage = {
      type: "CONFLICT",
      operationId: pending!.id,
      change: conflict,
    };

    await coordinator.handleServerMessage(message);

    expect((await store.getNote(DOCUMENT_ID))?.revision.content.body).toBe(
      saved.revision.content.body,
    );
    expect(await store.listConflicts()).toHaveLength(1);
    expect(coordinator.status()).toMatchObject({
      state: "conflict",
      conflicts: 1,
    });

    await coordinator.stop();
  });

  it("can replace a conflicted local note with the server snapshot", async () => {
    const store = new MemoryStore();
    await store.seedProject(project());
    const original = note("original");
    await store.seedNote(original);

    const coordinator = createSyncCoordinator({
      ownerId: OWNER_ID,
      store,
      client: network({
        pushOperations: vi.fn().mockRejectedValue(new Error("offline")),
      }),
    });
    await coordinator.start();

    await coordinator.updateNote(original, {
      title: "Sources",
      body: "my offline edit",
      baseRevisionId: original.revision.id,
    });
    const [pending] = await store.listPendingOperations(10);
    expect(pending).toBeDefined();

    await coordinator.handleServerMessage({
      type: "CONFLICT",
      operationId: pending!.id,
      change: {
        cursor: "9",
        operationId: pending!.id,
        entityType: "document",
        entityId: DOCUMENT_ID,
        kind: "conflict",
        revision: "66666666-6666-4666-8666-666666666666",
        payload: {
          current: {
            title: "Sources",
            body: "server edit",
            currentRevisionId: "66666666-6666-4666-8666-666666666666",
          },
        },
        createdAt: NOW,
      },
    });

    const resolved = await coordinator.resolveNoteConflict(
      pending!.id,
      "use-server",
    );

    expect(resolved.revision.content.body).toBe("server edit");
    expect(await store.listConflicts()).toEqual([]);
    expect(coordinator.status().state).toBe("synced");

    await coordinator.stop();
  });

  it("ignores conflict records that belong to another device operation", async () => {
    const store = new MemoryStore();
    const coordinator = createSyncCoordinator({
      ownerId: OWNER_ID,
      store,
      client: network(),
    });
    await coordinator.start();

    await coordinator.handleServerMessage({
      type: "CONFLICT",
      operationId: "88888888-8888-4888-8888-888888888888",
      change: {
        cursor: "9",
        operationId: "88888888-8888-4888-8888-888888888888",
        entityType: "document",
        entityId: DOCUMENT_ID,
        kind: "conflict",
        revision: REVISION_ID,
        payload: {
          current: {
            title: "Foreign",
            body: "other device",
            currentRevisionId: REVISION_ID,
          },
        },
        createdAt: NOW,
      },
    });

    expect(await store.listConflicts()).toEqual([]);
    expect(await store.getCursor()).toBe("9");
    expect(coordinator.status()).toMatchObject({
      state: "synced",
      cursor: "9",
    });

    await coordinator.stop();
  });

  it("drains pending operations sequentially in local creation order", async () => {
    const store = new MemoryStore();
    const client = network();
    const coordinator = createSyncCoordinator({
      ownerId: OWNER_ID,
      store,
      client,
    });
    await coordinator.start();

    const first = await coordinator.createProject({ name: "One" });
    const second = await coordinator.createProject({ name: "Two" });

    expect(first.name).toBe("One");
    expect(second.name).toBe("Two");

    const pushes = vi.mocked(client.pushOperations).mock.calls;
    expect(pushes.length).toBeGreaterThanOrEqual(2);
    expect(pushes.every(([operations]) => operations.length === 1)).toBe(true);

    await coordinator.stop();
  });
});
