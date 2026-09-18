import type { LocalStore } from "./store";
import { createSqliteLocalStore } from "./sqlite-store";

export async function openLocalStore(): Promise<LocalStore> {
  return createSqliteLocalStore();
}
