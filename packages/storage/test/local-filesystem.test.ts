import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  InvalidStorageKeyError,
  createLocalFilesystemStorage,
} from "../src/index.js";

const roots: string[] = [];

async function createStorage() {
  const root = await mkdtemp(join(tmpdir(), "uw-storage-"));
  roots.push(root);
  return { root, storage: createLocalFilesystemStorage(root) };
}

function opaqueKey() {
  return `${randomUUID()}/${randomUUID()}/${"a".repeat(64)}`;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("local filesystem storage", () => {
  it("atomically writes and reads a nested opaque key without temp residue", async () => {
    const { root, storage } = await createStorage();
    const key = opaqueKey();
    const bytes = new TextEncoder().encode("artifact payload");

    await storage.put({ key, bytes });

    await expect(storage.get(key)).resolves.toEqual(bytes);

    const [projectId, artifactId, checksum] = key.split("/");
    const leafEntries = await readdir(join(root, projectId!, artifactId!));
    expect(leafEntries).toEqual([checksum]);
  });

  it("creates parent directories and removes stored content", async () => {
    const { storage } = await createStorage();
    const key = opaqueKey();

    await storage.put({ key, bytes: new Uint8Array([1, 2, 3]) });
    await expect(storage.get(key)).resolves.toEqual(new Uint8Array([1, 2, 3]));

    await storage.remove(key);
    await expect(storage.get(key)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "../escape",
    "/absolute/path",
    "project/../escape",
    "project//artifact",
    `${randomUUID()}/${randomUUID()}/not-a-sha256`,
    `${randomUUID()}/not-a-uuid/${"a".repeat(64)}`,
  ])("rejects non-opaque or traversal key %s", async (key) => {
    const { storage } = await createStorage();

    await expect(
      storage.put({ key, bytes: new Uint8Array([1]) }),
    ).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(storage.get(key)).rejects.toBeInstanceOf(
      InvalidStorageKeyError,
    );
    await expect(storage.remove(key)).rejects.toBeInstanceOf(
      InvalidStorageKeyError,
    );
  });
});
