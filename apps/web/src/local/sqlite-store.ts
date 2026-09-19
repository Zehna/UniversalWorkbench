import type {
  NoteDocumentView,
  Project,
  SyncChange,
  SyncOperation,
} from "@uw/contracts";
import type {
  LocalConflictRecord,
  LocalDeviceRecord,
  LocalMutation,
  LocalStore,
  LocalTransaction,
} from "./store";

interface WorkerResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

type WorkerCommand =
  | { type: "init" }
  | { type: "transaction"; mutations: LocalMutation[] }
  | { type: "getDevice" }
  | { type: "setDevice"; device: LocalDeviceRecord }
  | { type: "getCursor" }
  | { type: "setCursor"; cursor: string }
  | { type: "listProjects" }
  | { type: "listNotes"; projectId: string }
  | { type: "getNote"; documentId: string }
  | { type: "listPendingOperations"; limit: number }
  | { type: "markOperationAcked"; operationId: string; cursor: string }
  | { type: "applyRemoteChange"; change: SyncChange }
  | { type: "listConflicts" }
  | { type: "close" };

class WorkerRpc {
  readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();

  constructor() {
    this.worker = new Worker(new URL("./sqlite-worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const waiter = this.pending.get(response.id);
      if (!waiter) return;
      this.pending.delete(response.id);
      if (response.ok) {
        waiter.resolve(response.value);
      } else {
        waiter.reject(
          new Error(response.error ?? "SQLite worker request failed"),
        );
      }
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "SQLite worker crashed");
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    };
  }

  call<T>(command: WorkerCommand): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.worker.postMessage({ id, ...command });
    });
  }
}

function createTransactionCollector(): {
  transaction: LocalTransaction;
  mutations: LocalMutation[];
} {
  const mutations: LocalMutation[] = [];
  const transaction: LocalTransaction = {
    async upsertProject(project) {
      mutations.push({
        type: "upsertProject",
        project: structuredClone(project),
      });
    },
    async upsertNote(note) {
      mutations.push({ type: "upsertNote", note: structuredClone(note) });
    },
    async putTombstone(tombstone) {
      mutations.push({
        type: "putTombstone",
        tombstone: structuredClone(tombstone),
      });
    },
    async appendOperation(operation) {
      mutations.push({
        type: "appendOperation",
        operation: structuredClone(operation),
      });
    },
  };
  return { transaction, mutations };
}

export async function createSqliteLocalStore(): Promise<LocalStore> {
  const rpc = new WorkerRpc();
  await rpc.call<null>({ type: "init" });

  return {
    async transaction<T>(fn: (tx: LocalTransaction) => Promise<T>) {
      const { transaction, mutations } = createTransactionCollector();
      const result = await fn(transaction);
      await rpc.call<null>({ type: "transaction", mutations });
      return result;
    },
    getDevice() {
      return rpc.call<LocalDeviceRecord | null>({ type: "getDevice" });
    },
    async setDevice(device) {
      await rpc.call<null>({ type: "setDevice", device });
    },
    getCursor() {
      return rpc.call<string>({ type: "getCursor" });
    },
    async setCursor(cursor) {
      await rpc.call<null>({ type: "setCursor", cursor });
    },
    listProjects() {
      return rpc.call<Project[]>({ type: "listProjects" });
    },
    listNotes(projectId) {
      return rpc.call<NoteDocumentView[]>({ type: "listNotes", projectId });
    },
    getNote(documentId) {
      return rpc.call<NoteDocumentView | null>({ type: "getNote", documentId });
    },
    listPendingOperations(limit) {
      return rpc.call<SyncOperation[]>({
        type: "listPendingOperations",
        limit,
      });
    },
    async markOperationAcked(operationId, cursor) {
      await rpc.call<null>({
        type: "markOperationAcked",
        operationId,
        cursor,
      });
    },
    async applyRemoteChange(change) {
      await rpc.call<null>({ type: "applyRemoteChange", change });
    },
    listConflicts() {
      return rpc.call<LocalConflictRecord[]>({ type: "listConflicts" });
    },
    async close() {
      try {
        await rpc.call<null>({ type: "close" });
      } finally {
        rpc.worker.terminate();
      }
    },
  };
}
