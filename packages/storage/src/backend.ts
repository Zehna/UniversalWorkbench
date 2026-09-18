export interface StoragePutInput {
  key: string;
  bytes: Uint8Array;
}

export interface StorageBackend {
  put(input: StoragePutInput): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  remove(key: string): Promise<void>;
}

export class InvalidStorageKeyError extends Error {
  constructor(key: string) {
    super(`Invalid opaque storage key: ${key}`);
    this.name = "InvalidStorageKeyError";
  }
}

const UUID_SEGMENT =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const OPAQUE_STORAGE_KEY = new RegExp(
  `^${UUID_SEGMENT}/${UUID_SEGMENT}/[a-f0-9]{64}$`,
);

export function assertOpaqueStorageKey(key: string): void {
  if (!OPAQUE_STORAGE_KEY.test(key)) {
    throw new InvalidStorageKeyError(key);
  }
}
