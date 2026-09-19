import type {
  CreateNoteRequest,
  CreateProjectRequest,
  NoteDocumentView,
  Project,
  ServerSyncMessage,
  SyncChange,
  SyncOperation,
  UpdateNoteRequest,
} from "@uw/contracts";
import {
  createNoteLocally,
  createProjectLocally,
  updateNoteLocally,
} from "../local/mutations";
import type {
  LocalConflictRecord,
  LocalDeviceRecord,
  LocalStore,
} from "../local/store";
import type {
  SyncConnection,
  SyncNetworkClient,
  SyncPushResult,
} from "./client";
import type { SyncStatus, SyncStatusListener } from "./status";

export type { SyncNetworkClient } from "./client";

export interface SyncCoordinator {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): SyncStatus;
  subscribe(listener: SyncStatusListener): () => void;
  listProjects(): Promise<Project[]>;
  listNotes(projectId: string): Promise<NoteDocumentView[]>;
  getNote(documentId: string): Promise<NoteDocumentView | null>;
  listConflicts(): Promise<LocalConflictRecord[]>;
  createProject(input: CreateProjectRequest): Promise<Project>;
  createNote(
    projectId: string,
    input: CreateNoteRequest,
  ): Promise<NoteDocumentView>;
  updateNote(
    view: NoteDocumentView,
    input: UpdateNoteRequest,
  ): Promise<NoteDocumentView>;
  handleServerMessage(message: ServerSyncMessage): Promise<void>;
}

interface CreateSyncCoordinatorOptions {
  ownerId: string;
  store: LocalStore;
  client: SyncNetworkClient;
  deviceLabel?: string;
}

function cursorAfter(left: string, right: string): boolean {
  return BigInt(left) > BigInt(right);
}

export function createSyncCoordinator(
  options: CreateSyncCoordinatorOptions,
): SyncCoordinator {
  const { ownerId, store, client } = options;
  const listeners = new Set<SyncStatusListener>();
  let currentStatus: SyncStatus = { state: "local-only" };
  let device: LocalDeviceRecord | null = null;
  let connection: SyncConnection | null = null;
  let networkAvailable = false;
  let syncing = false;
  let started = false;
  let stopped = false;
  let drainPromise: Promise<void> | null = null;

  function publish(next: SyncStatus): void {
    currentStatus = next;
    for (const listener of listeners) listener(next);
  }

  async function refreshStatus(): Promise<void> {
    const pending = (await store.listPendingOperations(500)).length;
    const conflicts = (await store.listConflicts()).length;

    if (conflicts > 0) {
      publish({ state: "conflict", pending, conflicts });
      return;
    }
    if (!networkAvailable) {
      publish({ state: "offline", pending });
      return;
    }
    if (syncing || pending > 0) {
      publish({ state: "syncing", pending });
      return;
    }
    publish({ state: "synced", cursor: await store.getCursor() });
  }

  async function ensureDevice(): Promise<LocalDeviceRecord> {
    const existing = await store.getDevice();
    if (existing?.ownerId === ownerId) return existing;

    const created: LocalDeviceRecord = {
      id: crypto.randomUUID(),
      ownerId,
      label: options.deviceLabel ?? "Universal Workbench Browser",
      createdAt: new Date().toISOString(),
    };
    await store.setDevice(created);
    return created;
  }

  async function hasPendingForChange(change: SyncChange): Promise<boolean> {
    const pending = await store.listPendingOperations(500);
    return pending.some(
      (operation) =>
        operation.id !== change.operationId &&
        operation.entityType === change.entityType &&
        operation.entityId === change.entityId,
    );
  }

  async function applyChangeSafely(change: SyncChange): Promise<void> {
    const cursor = await store.getCursor();
    if (!cursorAfter(change.cursor, cursor)) return;

    if (change.kind !== "conflict" && (await hasPendingForChange(change))) {
      await store.setCursor(change.cursor);
      return;
    }

    await store.applyRemoteChange(change);
  }

  async function applyPushResult(
    operation: SyncOperation,
    result: SyncPushResult,
  ): Promise<void> {
    if (result.operationId !== operation.id) {
      throw new Error("Sync result does not match pending operation");
    }

    if (result.change.kind === "conflict") {
      await applyChangeSafely(result.change);
      return;
    }

    await store.markOperationAcked(operation.id, result.change.cursor);
    await store.applyRemoteChange(result.change);
  }

  async function drainOnce(): Promise<void> {
    if (!networkAvailable) {
      await refreshStatus();
      return;
    }

    syncing = true;
    await refreshStatus();
    try {
      while (!stopped) {
        const [operation] = await store.listPendingOperations(1);
        if (!operation) break;

        const results = await client.pushOperations([operation]);
        const result = results[0];
        if (!result) {
          throw new Error("Sync server returned no operation result");
        }
        await applyPushResult(operation, result);
      }
    } catch {
      networkAvailable = false;
    } finally {
      syncing = false;
      await refreshStatus();
    }
  }

  function drainPending(): Promise<void> {
    if (drainPromise) return drainPromise;
    drainPromise = drainOnce().finally(() => {
      drainPromise = null;
    });
    return drainPromise;
  }

  async function catchUpHttp(): Promise<void> {
    let cursor = await store.getCursor();

    while (!stopped) {
      const changes = await client.listChanges(cursor, 500);
      if (changes.length === 0) return;

      for (const change of changes) {
        await applyChangeSafely(change);
        cursor = change.cursor;
      }

      if (changes.length < 500) return;
    }
  }

  async function handleServerMessage(
    message: ServerSyncMessage,
  ): Promise<void> {
    if (message.type === "ERROR") {
      networkAvailable = false;
      await refreshStatus();
      return;
    }

    if (message.type === "READY" || message.type === "PONG") {
      networkAvailable = true;
      await refreshStatus();
      return;
    }

    if (message.type === "ACK_OPERATION") {
      await store.markOperationAcked(message.operationId, message.cursor);
      networkAvailable = true;
      await refreshStatus();
      return;
    }

    await applyChangeSafely(message.change);
    networkAvailable = true;
    await refreshStatus();
  }

  return {
    async start() {
      if (started || stopped) return;
      started = true;
      device = await ensureDevice();

      try {
        await client.registerDevice({
          id: device.id,
          name: device.label ?? "Universal Workbench Browser",
        });
        networkAvailable = true;

        const cursor = await store.getCursor();
        connection = client.connect({
          deviceId: device.id,
          cursor,
          onMessage(message) {
            void handleServerMessage(message).catch(async () => {
              networkAvailable = false;
              await refreshStatus();
            });
          },
          onClose() {
            if (stopped) return;
            networkAvailable = false;
            void refreshStatus();
          },
          onError() {
            if (stopped) return;
            networkAvailable = false;
            void refreshStatus();
          },
        });

        await drainPending();
        if (networkAvailable) {
          try {
            await catchUpHttp();
          } catch {
            networkAvailable = false;
          }
        }
      } catch {
        networkAvailable = false;
      }

      await refreshStatus();
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      connection?.close();
      connection = null;
      await store.close();
    },

    status() {
      return currentStatus;
    },

    subscribe(listener) {
      listeners.add(listener);
      listener(currentStatus);
      return () => listeners.delete(listener);
    },

    listProjects() {
      return store.listProjects();
    },

    listNotes(projectId) {
      return store.listNotes(projectId);
    },

    getNote(documentId) {
      return store.getNote(documentId);
    },

    listConflicts() {
      return store.listConflicts();
    },

    async createProject(input) {
      device ??= await ensureDevice();
      const project = await createProjectLocally(store, device, input);
      await drainPending();
      return project;
    },

    async createNote(projectId, input) {
      device ??= await ensureDevice();
      const note = await createNoteLocally(store, device, projectId, input);
      await drainPending();
      return note;
    },

    async updateNote(view, input) {
      device ??= await ensureDevice();
      const note = await updateNoteLocally(store, device, view, input);
      await drainPending();
      return note;
    },

    handleServerMessage,
  };
}
