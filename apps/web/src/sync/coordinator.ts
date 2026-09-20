import {
  WorkflowDefinitionV1Schema,
  type CreateNoteRequest,
  CreateProjectRequest,
  NoteDocumentView,
  Project,
  ServerSyncMessage,
  SyncChange,
  SyncOperation,
  UpdateNoteRequest,
  CreateWorkflowRequest,
  UpdateWorkflowRequest,
  WorkflowDocumentView,
} from "@uw/contracts";
import {
  createNoteLocally,
  createProjectLocally,
  updateNoteLocally,
  createWorkflowLocally,
  updateWorkflowLocally,
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
import type { SyncWebSocketState } from "./client";

export type { SyncNetworkClient } from "./client";

export interface SyncDiagnostics {
  deviceId: string;
  backend: "opfs-sqlite" | "indexeddb";
  cursor: string;
  pendingOperations: number;
  conflicts: number;
  websocketState: SyncWebSocketState;
  lastAckAt: string | null;
  lastErrorCode: string | null;
}

export type WorkflowRunEligibility =
  | { state: "ready"; revisionId: string }
  | { state: "conflict"; operationId: string }
  | { state: "offline" | "pending" | "missing" };

export interface SyncCoordinator {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): SyncStatus;
  diagnostics(): Promise<SyncDiagnostics>;
  subscribe(listener: SyncStatusListener): () => void;
  listProjects(): Promise<Project[]>;
  listNotes(projectId: string): Promise<NoteDocumentView[]>;
  getNote(documentId: string): Promise<NoteDocumentView | null>;
  listWorkflows(projectId: string): Promise<WorkflowDocumentView[]>;
  getWorkflow(documentId: string): Promise<WorkflowDocumentView | null>;
  workflowRunEligibility(
    documentId: string,
  ): Promise<WorkflowRunEligibility>;
  listConflicts(): Promise<LocalConflictRecord[]>;
  resolveNoteConflict(
    operationId: string,
    strategy: "keep-local" | "use-server",
  ): Promise<NoteDocumentView>;
  resolveWorkflowConflict(
    operationId: string,
    strategy: "keep-local" | "use-server",
  ): Promise<WorkflowDocumentView>;
  createProject(input: CreateProjectRequest): Promise<Project>;
  createNote(
    projectId: string,
    input: CreateNoteRequest,
  ): Promise<NoteDocumentView>;
  updateNote(
    view: NoteDocumentView,
    input: UpdateNoteRequest,
  ): Promise<NoteDocumentView>;
  createWorkflow(
    projectId: string,
    input: CreateWorkflowRequest,
  ): Promise<WorkflowDocumentView>;
  updateWorkflow(
    view: WorkflowDocumentView,
    input: UpdateWorkflowRequest,
  ): Promise<WorkflowDocumentView>;
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

function serverNoteSnapshot(conflict: LocalConflictRecord): {
  title: string;
  body: string;
  currentRevisionId: string;
} {
  const current = conflict.change.payload.current;
  if (typeof current !== "object" || current === null) {
    throw new Error("Conflict does not contain a server note snapshot");
  }

  const record = current as Record<string, unknown>;
  if (
    typeof record.title !== "string" ||
    typeof record.body !== "string" ||
    typeof record.currentRevisionId !== "string"
  ) {
    throw new Error("Conflict server note snapshot is incomplete");
  }

  return {
    title: record.title,
    body: record.body,
    currentRevisionId: record.currentRevisionId,
  };
}

function serverWorkflowSnapshot(conflict: LocalConflictRecord): {
  title: string;
  workflow: WorkflowDocumentView["revision"]["content"]["workflow"];
  currentRevisionId: string;
} {
  const current = conflict.change.payload.current;
  if (typeof current !== "object" || current === null) {
    throw new Error("Conflict does not contain a server workflow snapshot");
  }

  const record = current as Record<string, unknown>;
  if (
    record.kind !== "workflow" ||
    typeof record.title !== "string" ||
    typeof record.currentRevisionId !== "string"
  ) {
    throw new Error("Conflict server workflow snapshot is incomplete");
  }

  return {
    title: record.title,
    workflow: WorkflowDefinitionV1Schema.parse(record.workflow),
    currentRevisionId: record.currentRevisionId,
  };
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
  let lastAckAt: string | null = null;
  let lastErrorCode: string | null = null;

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

    if (change.kind === "conflict") {
      const pending = await store.listPendingOperations(500);
      const belongsToThisDevice = pending.some(
        (operation) => operation.id === change.operationId,
      );
      if (!belongsToThisDevice) {
        await store.setCursor(change.cursor);
        return;
      }
    }

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
    lastAckAt = new Date().toISOString();
    lastErrorCode = null;
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
      lastErrorCode = "NETWORK_ERROR";
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
      lastErrorCode = message.code;
      await refreshStatus();
      return;
    }

    if (message.type === "READY" || message.type === "PONG") {
      networkAvailable = true;
      lastErrorCode = null;
      await refreshStatus();
      return;
    }

    if (message.type === "ACK_OPERATION") {
      await store.markOperationAcked(message.operationId, message.cursor);
      networkAvailable = true;
      lastAckAt = new Date().toISOString();
      lastErrorCode = null;
      await refreshStatus();
      return;
    }

    await applyChangeSafely(message.change);
    networkAvailable = true;
    lastErrorCode = null;
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
            lastErrorCode = "WEBSOCKET_CLOSED";
            void refreshStatus();
          },
          onError() {
            if (stopped) return;
            networkAvailable = false;
            lastErrorCode = "WEBSOCKET_ERROR";
            void refreshStatus();
          },
        });

        await drainPending();
        if (networkAvailable) {
          try {
            await catchUpHttp();
          } catch {
            networkAvailable = false;
            lastErrorCode = "HTTP_CATCHUP_ERROR";
          }
        }
      } catch {
        networkAvailable = false;
        lastErrorCode = "NETWORK_ERROR";
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

    async diagnostics() {
      device ??= await ensureDevice();
      const [cursor, pending, conflicts] = await Promise.all([
        store.getCursor(),
        store.listPendingOperations(500),
        store.listConflicts(),
      ]);
      return {
        deviceId: device.id,
        backend: store.backend,
        cursor,
        pendingOperations: pending.length,
        conflicts: conflicts.length,
        websocketState: connection?.state() ?? "closed",
        lastAckAt,
        lastErrorCode,
      };
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

    listWorkflows(projectId) {
      return store.listWorkflows(projectId);
    },

    getWorkflow(documentId) {
      return store.getWorkflow(documentId);
    },

    async workflowRunEligibility(documentId) {
      const workflow = await store.getWorkflow(documentId);
      if (!workflow) return { state: "missing" };

      const [pending, conflicts] = await Promise.all([
        store.listPendingOperations(500),
        store.listConflicts(),
      ]);
      const conflict = conflicts.find(
        (candidate) =>
          candidate.change.entityType === "document" &&
          candidate.change.entityId === documentId,
      );
      if (conflict) {
        return { state: "conflict", operationId: conflict.operationId };
      }
      if (
        pending.some(
          (operation) =>
            operation.entityType === "document" &&
            operation.entityId === documentId,
        )
      ) {
        return { state: "pending" };
      }
      if (!networkAvailable) return { state: "offline" };

      return {
        state: "ready",
        revisionId: workflow.revision.id,
      };
    },

    listConflicts() {
      return store.listConflicts();
    },

    async resolveNoteConflict(operationId, strategy) {
      const conflict = (await store.listConflicts()).find(
        (item) => item.operationId === operationId,
      );
      if (!conflict || conflict.change.entityType !== "document") {
        throw new Error("Note conflict was not found");
      }

      const local = await store.getNote(conflict.change.entityId);
      if (!local) throw new Error("Local note for conflict was not found");

      const server = serverNoteSnapshot(conflict);

      if (strategy === "use-server") {
        const timestamp = conflict.change.createdAt;
        const resolved: NoteDocumentView = {
          document: {
            ...local.document,
            title: server.title,
            currentRevisionId: server.currentRevisionId,
            updatedAt: timestamp,
          },
          revision: {
            id: server.currentRevisionId,
            documentId: local.document.id,
            revisionNumber: local.revision.revisionNumber + 1,
            parentRevisionId: local.revision.id,
            content: { body: server.body },
            metadata: {},
            createdAt: timestamp,
          },
        };
        await store.transaction((tx) => tx.upsertNote(resolved));
        await store.clearConflict(operationId);
        await refreshStatus();
        return resolved;
      }

      device ??= await ensureDevice();
      const retried = await updateNoteLocally(store, device, local, {
        title: local.document.title,
        body: local.revision.content.body,
        baseRevisionId: server.currentRevisionId,
      });
      await store.clearConflict(operationId);
      await drainPending();
      await refreshStatus();
      return retried;
    },

    async resolveWorkflowConflict(operationId, strategy) {
      const conflict = (await store.listConflicts()).find(
        (item) => item.operationId === operationId,
      );
      if (!conflict || conflict.change.entityType !== "document") {
        throw new Error("Workflow conflict was not found");
      }

      const local = await store.getWorkflow(conflict.change.entityId);
      if (!local) throw new Error("Local workflow for conflict was not found");

      const server = serverWorkflowSnapshot(conflict);

      if (strategy === "use-server") {
        const timestamp = conflict.change.createdAt;
        const resolved: WorkflowDocumentView = {
          document: {
            ...local.document,
            title: server.title,
            currentRevisionId: server.currentRevisionId,
            updatedAt: timestamp,
          },
          revision: {
            id: server.currentRevisionId,
            documentId: local.document.id,
            revisionNumber: local.revision.revisionNumber + 1,
            parentRevisionId: local.revision.id,
            content: {
              kind: "workflow",
              workflow: structuredClone(server.workflow),
            },
            metadata: {},
            createdAt: timestamp,
          },
        };
        await store.transaction((tx) => tx.upsertWorkflow(resolved));
        await store.clearConflict(operationId);
        await refreshStatus();
        return resolved;
      }

      device ??= await ensureDevice();
      const retried = await updateWorkflowLocally(store, device, local, {
        title: local.document.title,
        workflow: structuredClone(local.revision.content.workflow),
        baseRevisionId: server.currentRevisionId,
      });
      await store.clearConflict(operationId);
      await drainPending();
      await refreshStatus();
      return retried;
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

    async createWorkflow(projectId, input) {
      device ??= await ensureDevice();
      const workflow = await createWorkflowLocally(
        store,
        device,
        projectId,
        input,
      );
      await drainPending();
      return workflow;
    },

    async updateWorkflow(view, input) {
      device ??= await ensureDevice();
      const workflow = await updateWorkflowLocally(store, device, view, input);
      await drainPending();
      return workflow;
    },

    handleServerMessage,
  };
}
