import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  collectArtifactFiles,
  createBackupArchive,
  createTarArchive,
  readBackupArchive,
  verifyBackupIntegrity,
} from "@uw/storage";

const enc = new TextEncoder();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sampleInput() {
  return {
    databaseDump: enc.encode(
      "-- uw backup test dump\nCREATE TABLE t (id text);\n",
    ),
    artifacts: [
      {
        path: "artifacts/11111111-1111-4111-8111-111111111111/report.json",
        bytes: enc.encode('{"answer":42}'),
      },
      {
        path: "artifacts/11111111-1111-4111-8111-111111111111/note.txt",
        bytes: enc.encode("hello backup"),
      },
    ],
    vaultKeyVersions: [1],
    vaultRows: [
      {
        ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "api-key",
        keyVersion: 1,
        ivHex: "00".repeat(12),
        ciphertextHex: "ab".repeat(32),
        authTagHex: "cd".repeat(16),
      },
    ],
    createdAt: new Date("2026-10-08T00:00:00.000Z"),
  };
}

describe("unified backup creation", () => {
  it("archives database dump, artifacts, and vault envelope with a checksummed manifest", async () => {
    const archive = await createBackupArchive(sampleInput());
    expect(archive.byteLength).toBeGreaterThan(0);

    const { manifest, files } = await readBackupArchive(archive);
    expect(manifest.format).toBe("uw-backup");
    expect(manifest.version).toBe(1);
    expect(manifest.createdAt).toBe("2026-10-08T00:00:00.000Z");

    expect([...files.keys()].sort()).toEqual([
      "artifacts/11111111-1111-4111-8111-111111111111/note.txt",
      "artifacts/11111111-1111-4111-8111-111111111111/report.json",
      "database.sql",
      "manifest.json",
      "vault/envelope.json",
    ]);
    expect(new TextDecoder().decode(files.get("database.sql"))).toContain(
      "CREATE TABLE",
    );

    // Every manifest checksum matches the archived bytes.
    for (const entry of manifest.files) {
      const bytes = files.get(entry.path);
      expect(bytes).toBeDefined();
      expect(entry.sha256).toBe(sha256(bytes!));
      expect(entry.sizeBytes).toBe(bytes!.byteLength);
    }
    expect(manifest.vault.keyVersions).toEqual([1]);
    expect(manifest.vault.rows).toBe(1);
  });

  it("verifies integrity and rejects tampered archives", async () => {
    const archive = await createBackupArchive(sampleInput());
    const manifest = await verifyBackupIntegrity(archive);
    expect(manifest.format).toBe("uw-backup");

    // Flip a byte deep in the archive so decompression or parsing breaks.
    const tampered = new Uint8Array(archive);
    tampered[Math.floor(tampered.byteLength / 2)]! ^= 0xff;
    await expect(verifyBackupIntegrity(tampered)).rejects.toThrow();

    // A lying manifest (checksum mismatch) is rejected even when the
    // container is well-formed.
    const good = await readBackupArchive(archive);
    const lyingManifest = {
      ...good.manifest,
      files: good.manifest.files.map((entry, index) =>
        index === 0 ? { ...entry, sha256: "0".repeat(64) } : entry,
      ),
    };
    const lyingFiles = [...good.files.entries()].map(([path, bytes]) => ({
      path,
      bytes: path === "manifest.json" ? enc.encode(JSON.stringify(lyingManifest)) : bytes,
    }));
    const lyingArchive = gzipSync(createTarArchive(lyingFiles));
    await expect(
      verifyBackupIntegrity(new Uint8Array(lyingArchive)),
    ).rejects.toThrow(/checksum|integrity|mismatch/i);
  });

  it("never stores secrets, key material, or connection strings in plaintext", async () => {
    const sentinelPassword = `test-plaintext-secret-${randomBytes(8).toString("hex")}`;
    const fakeMasterKeyHex = randomBytes(32).toString("hex");
    const fakeDatabaseUrl = `postgres://backup:password-with-${sentinelPassword}@localhost:5432/db`;
    process.env.BACKUP_TEST_DATABASE_URL = fakeDatabaseUrl;
    try {
      const archive = await createBackupArchive(sampleInput());
      const raw = Buffer.from(archive).toString("latin1");
      const inflated = gunzipSync(archive).toString("latin1");
      expect(raw).not.toContain(sentinelPassword);
      expect(inflated).not.toContain(sentinelPassword);
      expect(raw).not.toContain(fakeMasterKeyHex);
      expect(inflated).not.toContain(fakeMasterKeyHex);
      expect(raw).not.toContain(fakeDatabaseUrl);
      expect(inflated).not.toContain(fakeDatabaseUrl);

      const { files } = await readBackupArchive(archive);
      const envelope = JSON.parse(
        new TextDecoder().decode(files.get("vault/envelope.json")!),
      );
      expect(envelope.keyMaterial).toBeUndefined();
      expect(envelope.plaintext).toBeUndefined();
      for (const row of envelope.rows) {
        expect(Object.keys(row).sort()).toEqual(
          ["authTagHex", "ciphertextHex", "ivHex", "keyVersion", "name", "ownerId"],
        );
        for (const value of Object.values(row)) {
          expect(String(value)).not.toContain(sentinelPassword);
        }
      }
    } finally {
      delete process.env.BACKUP_TEST_DATABASE_URL;
    }
  });

  it("collects artifact files with safe relative paths and skips symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "uw-backup-test-"));
    try {
      await mkdir(join(root, "proj", "nested"), { recursive: true });
      await writeFile(join(root, "proj", "a.json"), '{"a":1}');
      await writeFile(join(root, "proj", "nested", "b.txt"), "b");
      await symlink(
        join(root, "proj", "a.json"),
        join(root, "proj", "link.json"),
      );

      const collected = await collectArtifactFiles(root);
      const paths = collected.map((file) => file.path).sort();
      expect(paths).toEqual([
        "artifacts/proj/a.json",
        "artifacts/proj/nested/b.txt",
      ]);
      for (const file of collected) {
        expect(file.path).not.toContain("..");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe archive paths", async () => {
    await expect(
      createBackupArchive({
        ...sampleInput(),
        artifacts: [{ path: "../escape.txt", bytes: enc.encode("x") }],
      }),
    ).rejects.toThrow(/unsafe|path/i);
  });
});

function runCli(...args: string[]): Promise<{ code: number; stdout: string }> {
  const here = dirname(fileURLToPath(import.meta.url));
  const script = resolve(here, "../../../scripts/backup-create.mjs");
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [script, ...args], (error, stdout) => {
      resolvePromise({
        code: error && "code" in error ? Number(error.code) : 0,
        stdout: String(stdout),
      });
    });
  });
}

describe("backup-create CLI", () => {
  it("prints usage with --help and exits 0 without touching any service", async () => {
    const result = await runCli("--help");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/--out|usage/i);
  });

  it("rejects unknown flags with a non-zero exit", async () => {
    const result = await runCli("--bogus-flag");
    expect(result.code).not.toBe(0);
  });
});
