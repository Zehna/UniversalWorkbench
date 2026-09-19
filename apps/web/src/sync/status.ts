export type SyncStatus =
  | { state: "local-only" }
  | { state: "offline"; pending: number }
  | { state: "syncing"; pending: number }
  | { state: "synced"; cursor: string }
  | { state: "conflict"; pending: number; conflicts: number };

export type SyncStatusListener = (status: SyncStatus) => void;
