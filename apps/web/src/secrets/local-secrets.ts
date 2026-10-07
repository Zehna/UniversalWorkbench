import { parseSecretRef } from "@uw/contracts";

export interface LocalSecretStore {
  list(): Promise<string[]>;
  put(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
  get(name: string): Promise<string | null>;
}

export const LOCAL_SECRETS_DB_NAME = "universal-workbench-local-secrets";
export const LOCAL_SECRETS_STORE_NAME = "secrets";
export const LOCAL_SECRET_VALUE_MAX_BYTES = 8 * 1024;

export const LOCAL_SECRETS_DEVICE_WARNING =
  "Local Secrets hanya tersimpan pada perangkat/browser ini.";
export const LOCAL_SECRETS_VAULT_WARNING =
  "IndexedDB bukan encrypted credential vault.";
export const LOCAL_SECRET_SERVER_WARNING =
  "secret://local/* stays on this device; server runs will fail.";

export function toLocalSecretRef(name: string): string {
  const valid = validateLocalSecretName(name);
  return `secret://local/${valid}`;
}

export function validateLocalSecretName(name: unknown): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Invalid secret name");
  }
  let parsed: { scope: string; name: string };
  try {
    parsed = parseSecretRef(`secret://local/${name}`);
  } catch {
    throw new Error("Invalid secret name");
  }
  if (parsed.scope !== "local") {
    throw new Error("Invalid secret name");
  }
  return parsed.name;
}

function validateLocalSecretValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Invalid secret value");
  }
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes < 1 || bytes > LOCAL_SECRET_VALUE_MAX_BYTES) {
    throw new Error("Invalid secret value");
  }
  return value;
}

function validateOwnerId(ownerId: unknown): string {
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    throw new Error("Invalid owner");
  }
  return ownerId;
}

export function isServerUnresolvableSecretRef(ref: unknown): boolean {
  if (typeof ref !== "string") return false;
  try {
    const parsed = parseSecretRef(ref);
    return parsed.scope === "local";
  } catch {
    return false;
  }
}

export function findServerUnresolvableSecretRefs(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      if (isServerUnresolvableSecretRef(node)) {
        found.add(node);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const child of Object.values(node as Record<string, unknown>)) {
        visit(child);
      }
    }
  };
  visit(value);
  return [...found].sort();
}

interface SecretRecord {
  key: string;
  ownerId: string;
  name: string;
  value: string;
  updatedAt: string;
}

function recordKey(ownerId: string, name: string): string {
  return `${ownerId}\0${name}`;
}

type FallbackMap = Map<string, SecretRecord>;

function fallbackMap(): FallbackMap {
  const g = globalThis as unknown as Record<string, unknown>;
  const existing = g.__uwLocalSecretsFallback;
  if (existing instanceof Map) {
    return existing as FallbackMap;
  }
  const created: FallbackMap = new Map();
  g.__uwLocalSecretsFallback = created;
  return created;
}

function hasIndexedDb(): boolean {
  return (
    typeof indexedDB !== "undefined" &&
    indexedDB !== null &&
    typeof (indexedDB as IDBFactory).open === "function"
  );
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

function openSecretsDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(LOCAL_SECRETS_STORE_NAME)) {
        database.createObjectStore(LOCAL_SECRETS_STORE_NAME, {
          keyPath: "key",
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

export function createLocalSecretStore(
  ownerId: string,
  options?: { dbName?: string },
): LocalSecretStore {
  const owner = validateOwnerId(ownerId);
  const dbName = options?.dbName ?? LOCAL_SECRETS_DB_NAME;

  async function idb<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => Promise<T> | T,
  ): Promise<T> {
    const database = await openSecretsDatabase(dbName);
    try {
      const transaction = database.transaction(LOCAL_SECRETS_STORE_NAME, mode);
      const objectStore = transaction.objectStore(LOCAL_SECRETS_STORE_NAME);
      const result = await fn(objectStore);
      if (mode !== "readonly") {
        await transactionDone(transaction);
      }
      return result;
    } finally {
      database.close();
    }
  }

  return {
    async put(name: string, value: string): Promise<void> {
      const validName = validateLocalSecretName(name);
      const validValue = validateLocalSecretValue(value);
      if (!hasIndexedDb()) {
        fallbackMap().set(recordKey(owner, validName), {
          key: recordKey(owner, validName),
          ownerId: owner,
          name: validName,
          value: validValue,
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      await idb("readwrite", (store) => {
        const record: SecretRecord = {
          key: recordKey(owner, validName),
          ownerId: owner,
          name: validName,
          value: validValue,
          updatedAt: new Date().toISOString(),
        };
        store.put(record);
      });
    },

    async get(name: string): Promise<string | null> {
      const validName = validateLocalSecretName(name);
      if (!hasIndexedDb()) {
        return fallbackMap().get(recordKey(owner, validName))?.value ?? null;
      }
      return idb("readonly", async (store) => {
        const record = await requestResult<SecretRecord | undefined>(
          store.get(recordKey(owner, validName)),
        );
        if (!record || record.ownerId !== owner) return null;
        return record.value;
      });
    },

    async list(): Promise<string[]> {
      if (!hasIndexedDb()) {
        const names: string[] = [];
        for (const record of fallbackMap().values()) {
          if (record.ownerId === owner) {
            names.push(record.name);
          }
        }
        return names.sort();
      }
      return idb("readonly", async (store) => {
        const records = await requestResult<SecretRecord[]>(store.getAll());
        return records
          .filter((record) => record.ownerId === owner)
          .map((record) => record.name)
          .sort();
      });
    },

    async remove(name: string): Promise<void> {
      const validName = validateLocalSecretName(name);
      if (!hasIndexedDb()) {
        fallbackMap().delete(recordKey(owner, validName));
        return;
      }
      await idb("readwrite", (store) => {
        store.delete(recordKey(owner, validName));
      });
    },
  };
}
