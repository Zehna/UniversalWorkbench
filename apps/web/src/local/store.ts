import type {
  NoteDocumentView,
  Project,
  WorkflowDocumentView,
  SyncChange,
  SyncEntityType,
  SyncOperation,
} from "@uw/contracts";

export type LocalStoreBackend = "opfs-sqlite" | "indexeddb";

export interface LocalDeviceRecord {
  id: string;
  ownerId: string;
  label: string | null;
  createdAt: string;
}

export interface LocalTombstone {
  entityType: SyncEntityType;
  entityId: string;
  cursor: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface LocalConflictRecord {
  operationId: string;
  change: SyncChange;
  createdAt: string;
}

export type LocalMutation =
  | { type: "upsertProject"; project: Project }
  | { type: "upsertNote"; note: NoteDocumentView }
  | { type: "upsertWorkflow"; workflow: WorkflowDocumentView }
  | { type: "putTombstone"; tombstone: LocalTombstone }
  | { type: "appendOperation"; operation: SyncOperation };

export interface LocalTransaction {
  upsertProject(project: Project): Promise<void>;
  upsertNote(note: NoteDocumentView): Promise<void>;
  upsertWorkflow(workflow: WorkflowDocumentView): Promise<void>;
  putTombstone(tombstone: LocalTombstone): Promise<void>;
  appendOperation(operation: SyncOperation): Promise<void>;
}

export interface LocalStore {
  readonly backend: LocalStoreBackend;
  transaction<T>(fn: (tx: LocalTransaction) => Promise<T>): Promise<T>;
  getDevice(): Promise<LocalDeviceRecord | null>;
  setDevice(device: LocalDeviceRecord): Promise<void>;
  getCursor(): Promise<string>;
  setCursor(cursor: string): Promise<void>;
  listProjects(): Promise<Project[]>;
  listNotes(projectId: string): Promise<NoteDocumentView[]>;
  getNote(documentId: string): Promise<NoteDocumentView | null>;
  listWorkflows(projectId: string): Promise<WorkflowDocumentView[]>;
  getWorkflow(documentId: string): Promise<WorkflowDocumentView | null>;
  listPendingOperations(limit: number): Promise<SyncOperation[]>;
  markOperationAcked(operationId: string, cursor: string): Promise<void>;
  applyRemoteChange(change: SyncChange): Promise<void>;
  listConflicts(): Promise<LocalConflictRecord[]>;
  clearConflict(operationId: string): Promise<void>;
  close(): Promise<void>;
}
