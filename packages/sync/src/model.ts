import type { SyncChange, SyncOperation } from "@uw/contracts";

export const INITIAL_SYNC_CURSOR = "0" as const;

export type LocalOperationStatus =
  | "pending"
  | "sent"
  | "acked"
  | "conflict";

export interface LocalOperationRecord {
  operation: SyncOperation;
  status: LocalOperationStatus;
  ackCursor: string | null;
  conflict: SyncChange | null;
}

export function compareSyncCursors(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
