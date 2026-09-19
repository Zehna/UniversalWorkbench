import type { SyncStatus } from "./status";

function statusText(status: SyncStatus): string {
  switch (status.state) {
    case "local-only":
      return "Local only";
    case "offline":
      return status.pending > 0
        ? `Offline · ${status.pending} pending`
        : "Offline";
    case "syncing":
      return `Syncing · ${status.pending} pending`;
    case "synced":
      return "Synced";
    case "conflict":
      return `Conflict · ${status.conflicts}`;
  }
}

export function SyncStatusBadge({ status }: { status: SyncStatus }) {
  return (
    <p role="status" aria-label="Sync status">
      Sync: {statusText(status)}
    </p>
  );
}
