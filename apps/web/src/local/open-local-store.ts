import { createIndexedDbLocalStore } from "./indexeddb-store";
import { createSqliteLocalStore } from "./sqlite-store";
import type { LocalStore } from "./store";

function canAttemptSqliteOpfs(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function"
  );
}

function isOpfsAvailabilityError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /opfs|origin private|sharedarraybuffer|cross.?origin|unavailable/i.test(
    error.message,
  );
}

export async function openLocalStore(): Promise<LocalStore> {
  if (!canAttemptSqliteOpfs()) return createIndexedDbLocalStore();

  try {
    return await createSqliteLocalStore();
  } catch (error) {
    if (!isOpfsAvailabilityError(error)) throw error;
    return createIndexedDbLocalStore();
  }
}
