import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  assertOpaqueStorageKey,
  type StorageBackend,
  type StoragePutInput,
} from "./backend.js";

function storagePath(root: string, key: string): string {
  assertOpaqueStorageKey(key);
  return join(root, ...key.split("/"));
}

export function createLocalFilesystemStorage(rootDir: string): StorageBackend {
  const root = resolve(rootDir);

  return {
    async put(input: StoragePutInput) {
      const target = storagePath(root, input.key);
      const parent = dirname(target);
      await mkdir(parent, { recursive: true });

      const temporary = join(parent, `.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, input.bytes, { flag: "wx" });
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },

    async get(key: string) {
      const target = storagePath(root, key);
      const bytes = await readFile(target);
      return new Uint8Array(bytes);
    },

    async remove(key: string) {
      const target = storagePath(root, key);
      await rm(target, { force: true });
    },
  };
}
