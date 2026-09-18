import type {
  NoteDocumentView,
  Project,
  SyncChange,
  SyncEntityType,
  SyncOperation,
} from "@uw/contracts";

export interface LocalDeviceRecord {
  id: string;
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
  | { type: "putTombstone"; tombstone: LocalTombstone }
  | { type: "appendOperation"; operation: SyncOperation };

export interface LocalTransaction {
  upsertProject(project: Project): Promise<void>;
  upsertNote(note: NoteDocumentView): Promise<void>;
  putTombstone(tombstone: LocalTombstone): Promise<void>;
  appendOperation(operation: SyncOperation): Promise<void>;
}

export interface LocalStore {
  transaction<T>(fn: (tx: LocalTransaction) => Promise<T>): Promise<T>;
  getDevice(): Promise<LocalDeviceRecord | null>;
  setDevice(device: LocalDeviceRecord): Promise<void>;
  getCursor(): Promise<string>;
  setCursor(cursor: string): Promise<void>;
  listProjects(): Promise<Project[]>;
  listPendingOperations(limit: number): Promise<SyncOperation[]>;
  markOperationAcked(operationId: string, cursor: string): Promise<void>;
  applyRemoteChange(change: SyncChange): Promise<void>;
  listConflicts(): Promise<LocalConflictRecord[]>;
  close(): Promise<void>;
}
