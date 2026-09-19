import type {
  Artifact,
  DocumentRevision,
  NoteDocument,
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
  LocalTombstone,
} from "./store";

const DATABASE_NAME = "universal-workbench-local";
const DATABASE_VERSION = 1;

const STORES = {
  meta: "local_meta",
  projects: "projects",
  documents: "documents",
  revisions: "document_revisions",
  artifacts: "artifacts",
  pending: "pending_operations",
  conflicts: "conflicts",
  tombstones: "tombstones",
} as const;

interface MetaRecord {
  key: string;
  value: unknown;
}

interface PendingOperationRecord {
  operationId: string;
  operation: SyncOperation;
  status: "pending" | "acked" | "conflict";
  ackCursor: string | null;
  createdAt: string;
}

interface ConflictRecord {
  operationId: string;
  change: SyncChange;
  createdAt: string;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORES.meta)) {
        database.createObjectStore(STORES.meta, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(STORES.projects)) {
        database.createObjectStore(STORES.projects, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(STORES.documents)) {
        database.createObjectStore(STORES.documents, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(STORES.revisions)) {
        database.createObjectStore(STORES.revisions, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(STORES.artifacts)) {
        database.createObjectStore(STORES.artifacts, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(STORES.pending)) {
        database.createObjectStore(STORES.pending, { keyPath: "operationId" });
      }
      if (!database.objectStoreNames.contains(STORES.conflicts)) {
        database.createObjectStore(STORES.conflicts, {
          keyPath: "operationId",
        });
      }
      if (!database.objectStoreNames.contains(STORES.tombstones)) {
        database.createObjectStore(STORES.tombstones, {
          keyPath: ["entityType", "entityId"],
        });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () =>
      reject(new Error("IndexedDB upgrade is blocked by another tab"));
  });
}

function createTransactionCollector(): {
  transaction: LocalTransaction;
  mutations: LocalMutation[];
} {
  const mutations: LocalMutation[] = [];
  return {
    mutations,
    transaction: {
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
    },
  };
}

function applyMutation(
  transaction: IDBTransaction,
  mutation: LocalMutation,
): void {
  if (mutation.type === "upsertProject") {
    transaction.objectStore(STORES.projects).put(mutation.project);
    return;
  }

  if (mutation.type === "upsertNote") {
    transaction.objectStore(STORES.documents).put(mutation.note.document);
    transaction.objectStore(STORES.revisions).put(mutation.note.revision);
    return;
  }

  if (mutation.type === "putTombstone") {
    transaction.objectStore(STORES.tombstones).put(mutation.tombstone);
    return;
  }

  const record: PendingOperationRecord = {
    operationId: mutation.operation.id,
    operation: mutation.operation,
    status: "pending",
    ackCursor: null,
    createdAt: mutation.operation.createdAt,
  };
  transaction.objectStore(STORES.pending).add(record);
}

function deleteDocumentRevisions(
  store: IDBObjectStore,
  documentId: string,
): void {
  const cursor = store.openCursor();
  cursor.onsuccess = () => {
    const current = cursor.result;
    if (!current) return;
    const revision = current.value as { documentId?: string };
    if (revision.documentId === documentId) current.delete();
    current.continue();
  };
}

function applyRemoteChangeToTransaction(
  transaction: IDBTransaction,
  change: SyncChange,
): void {
  if (change.kind === "conflict") {
    const conflict: ConflictRecord = {
      operationId: change.operationId,
      change,
      createdAt: change.createdAt,
    };
    transaction.objectStore(STORES.conflicts).put(conflict);

    const pendingStore = transaction.objectStore(STORES.pending);
    const pendingRequest = pendingStore.get(change.operationId);
    pendingRequest.onsuccess = () => {
      const current = pendingRequest.result as
        PendingOperationRecord | undefined;
      if (!current) return;
      pendingStore.put({ ...current, status: "conflict" });
    };
  } else if (change.kind === "tombstone") {
    if (change.entityType === "project") {
      transaction.objectStore(STORES.projects).delete(change.entityId);
    } else if (change.entityType === "document") {
      transaction.objectStore(STORES.documents).delete(change.entityId);
      deleteDocumentRevisions(
        transaction.objectStore(STORES.revisions),
        change.entityId,
      );
    } else {
      transaction.objectStore(STORES.artifacts).delete(change.entityId);
    }

    const tombstone: LocalTombstone = {
      entityType: change.entityType,
      entityId: change.entityId,
      cursor: change.cursor,
      payload: change.payload,
      createdAt: change.createdAt,
    };
    transaction.objectStore(STORES.tombstones).put(tombstone);
  } else if (change.entityType === "project") {
    const project = change.payload.project as Project | undefined;
    if (project) transaction.objectStore(STORES.projects).put(project);
  } else if (change.entityType === "document") {
    const note = change.payload.note as NoteDocumentView | undefined;
    if (note) {
      transaction.objectStore(STORES.documents).put(note.document);
      transaction.objectStore(STORES.revisions).put(note.revision);
    }
  } else {
    const artifact = change.payload.artifact as Artifact | undefined;
    if (artifact) transaction.objectStore(STORES.artifacts).put(artifact);
  }

  const meta: MetaRecord = { key: "cursor", value: change.cursor };
  transaction.objectStore(STORES.meta).put(meta);
}

export async function createIndexedDbLocalStore(): Promise<LocalStore> {
  const database = await openDatabase();

  return {
    async transaction<T>(fn: (tx: LocalTransaction) => Promise<T>) {
      const collected = createTransactionCollector();
      const result = await fn(collected.transaction);
      const transaction = database.transaction(
        [
          STORES.projects,
          STORES.documents,
          STORES.revisions,
          STORES.tombstones,
          STORES.pending,
        ],
        "readwrite",
      );
      for (const mutation of collected.mutations) {
        applyMutation(transaction, mutation);
      }
      await transactionDone(transaction);
      return result;
    },

    async getDevice() {
      const transaction = database.transaction(STORES.meta, "readonly");
      const result = await requestResult<MetaRecord | undefined>(
        transaction.objectStore(STORES.meta).get("device"),
      );
      return (result?.value as LocalDeviceRecord | undefined) ?? null;
    },

    async setDevice(device) {
      const transaction = database.transaction(STORES.meta, "readwrite");
      transaction.objectStore(STORES.meta).put({
        key: "device",
        value: structuredClone(device),
      } satisfies MetaRecord);
      await transactionDone(transaction);
    },

    async getCursor() {
      const transaction = database.transaction(STORES.meta, "readonly");
      const result = await requestResult<MetaRecord | undefined>(
        transaction.objectStore(STORES.meta).get("cursor"),
      );
      return typeof result?.value === "string" ? result.value : "0";
    },

    async setCursor(cursor) {
      const transaction = database.transaction(STORES.meta, "readwrite");
      transaction.objectStore(STORES.meta).put({
        key: "cursor",
        value: cursor,
      } satisfies MetaRecord);
      await transactionDone(transaction);
    },

    async listProjects() {
      const transaction = database.transaction(STORES.projects, "readonly");
      const projects = await requestResult<Project[]>(
        transaction.objectStore(STORES.projects).getAll(),
      );
      return projects.sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
    },

    async listNotes(projectId) {
      const documentTransaction = database.transaction(
        STORES.documents,
        "readonly",
      );
      const documents = await requestResult<NoteDocument[]>(
        documentTransaction.objectStore(STORES.documents).getAll(),
      );
      const matching = documents
        .filter((document) => document.projectId === projectId)
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) ||
            left.id.localeCompare(right.id),
        );

      const views = await Promise.all(
        matching.map(async (document) => {
          const revisionTransaction = database.transaction(
            STORES.revisions,
            "readonly",
          );
          const revision = await requestResult<DocumentRevision | undefined>(
            revisionTransaction
              .objectStore(STORES.revisions)
              .get(document.currentRevisionId),
          );
          return revision
            ? ({ document, revision } satisfies NoteDocumentView)
            : null;
        }),
      );

      return views.filter(
        (view): view is NoteDocumentView => view !== null,
      );
    },

    async getNote(documentId) {
      const documentTransaction = database.transaction(
        STORES.documents,
        "readonly",
      );
      const document = await requestResult<NoteDocument | undefined>(
        documentTransaction.objectStore(STORES.documents).get(documentId),
      );
      if (!document) return null;

      const revisionTransaction = database.transaction(
        STORES.revisions,
        "readonly",
      );
      const revision = await requestResult<DocumentRevision | undefined>(
        revisionTransaction
          .objectStore(STORES.revisions)
          .get(document.currentRevisionId),
      );
      return revision
        ? ({ document, revision } satisfies NoteDocumentView)
        : null;
    },

    async listPendingOperations(limit) {
      const transaction = database.transaction(STORES.pending, "readonly");
      const records = await requestResult<PendingOperationRecord[]>(
        transaction.objectStore(STORES.pending).getAll(),
      );
      return records
        .filter((record) => record.status === "pending")
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) ||
            left.operationId.localeCompare(right.operationId),
        )
        .slice(0, Math.max(1, Math.min(500, limit)))
        .map((record) => structuredClone(record.operation));
    },

    async markOperationAcked(operationId, cursor) {
      const transaction = database.transaction(
        [STORES.pending, STORES.meta],
        "readwrite",
      );
      const pendingStore = transaction.objectStore(STORES.pending);
      const request = pendingStore.get(operationId);
      request.onsuccess = () => {
        const current = request.result as PendingOperationRecord | undefined;
        if (current) {
          pendingStore.put({
            ...current,
            status: "acked",
            ackCursor: cursor,
          });
        }
      };
      transaction.objectStore(STORES.meta).put({
        key: "cursor",
        value: cursor,
      } satisfies MetaRecord);
      await transactionDone(transaction);
    },

    async applyRemoteChange(change) {
      const transaction = database.transaction(
        [
          STORES.meta,
          STORES.projects,
          STORES.documents,
          STORES.revisions,
          STORES.artifacts,
          STORES.pending,
          STORES.conflicts,
          STORES.tombstones,
        ],
        "readwrite",
      );
      applyRemoteChangeToTransaction(transaction, change);
      await transactionDone(transaction);
    },

    async listConflicts() {
      const transaction = database.transaction(STORES.conflicts, "readonly");
      const records = await requestResult<ConflictRecord[]>(
        transaction.objectStore(STORES.conflicts).getAll(),
      );
      return records
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) ||
            left.operationId.localeCompare(right.operationId),
        )
        .map((record): LocalConflictRecord => ({
          operationId: record.operationId,
          change: structuredClone(record.change),
          createdAt: record.createdAt,
        }));
    },

    async close() {
      database.close();
    },
  };
}
