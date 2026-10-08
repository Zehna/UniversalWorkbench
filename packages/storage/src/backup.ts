import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export const BACKUP_FORMAT = "uw-backup";
export const BACKUP_VERSION = 1;

export class UnsafeBackupPathError extends Error {
  constructor(path: string) {
    super(`Unsafe backup archive path: ${path}`);
    this.name = "UnsafeBackupPathError";
  }
}

export class BackupIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupIntegrityError";
  }
}

/** Lowercase hex sha256 of a payload. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export const MAX_ARCHIVE_PATH_BYTES = 256;

function assertSafeArchivePath(path: string): void {
  if (
    path.length === 0 ||
    new TextEncoder().encode(path).byteLength > MAX_ARCHIVE_PATH_BYTES
  ) {
    throw new UnsafeBackupPathError(path);
  }
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new UnsafeBackupPathError(path);
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional guard
  if (/[\x00-\x1f\x7f]/.test(path)) {
    throw new UnsafeBackupPathError(path);
  }
}

export interface TarEntryInput {
  path: string;
  bytes: Uint8Array;
}

function writeOctal(value: number, length: number): Uint8Array {
  const text = `${value.toString(8).padStart(length - 1, "0")}\0`;
  return new TextEncoder().encode(text);
}

function splitUstarPath(name: string): { name: string; prefix: string } {
  const nameBytes = new TextEncoder().encode(name);
  if (nameBytes.byteLength <= 100) return { name, prefix: "" };
  // USTAR prefix field (155 bytes): split at a separator so both halves fit.
  const slash = name.lastIndexOf("/", 100);
  if (slash <= 0) throw new UnsafeBackupPathError(name);
  const prefix = name.slice(0, slash);
  const rest = name.slice(slash + 1);
  const prefixBytes = new TextEncoder().encode(prefix);
  const restBytes = new TextEncoder().encode(rest);
  if (prefixBytes.byteLength > 155 || restBytes.byteLength > 100) {
    throw new UnsafeBackupPathError(name);
  }
  return { name: rest, prefix };
}

function encodeTarHeader(path: string, size: number, mtime: number): Uint8Array {
  assertSafeArchivePath(path);
  const { name, prefix } = splitUstarPath(path);
  const header = new Uint8Array(512);
  header.set(new TextEncoder().encode(name), 0);
  header.set(new TextEncoder().encode(prefix), 345);
  header.set(writeOctal(0o644, 8), 100);
  header.set(writeOctal(0, 8), 108);
  header.set(writeOctal(0, 8), 116);
  header.set(writeOctal(size, 12), 124);
  header.set(writeOctal(mtime, 12), 136);
  // Checksum field is spaces while computing.
  header.fill(0x20, 148, 156);
  header[156] = 0x30; // regular file
  header.set(new TextEncoder().encode("ustar\0"), 257);
  header.set(new TextEncoder().encode("00"), 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  const checksum = `${sum.toString(8).padStart(6, "0")}\0 `;
  header.set(new TextEncoder().encode(checksum), 148);
  return header;
}

/** Pack regular files into a standards-compliant USTAR archive. */
export function createTarArchive(entries: TarEntryInput[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const mtime = Math.floor(Date.now() / 1000);
  for (const entry of entries) {
    chunks.push(encodeTarHeader(entry.path, entry.bytes.byteLength, mtime));
    chunks.push(entry.bytes);
    const padding = (512 - (entry.bytes.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024)); // two zero blocks: end of archive
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function parseOctal(bytes: Uint8Array, offset: number, length: number): number {
  const text = new TextDecoder().decode(bytes.slice(offset, offset + length));
  const cleaned = text.replace(/\0| /g, "");
  if (!/^[0-7]*$/.test(cleaned) || cleaned.length === 0) {
    throw new BackupIntegrityError("Corrupt tar header number");
  }
  return Number.parseInt(cleaned, 8);
}

/** Unpack a USTAR archive, verifying header checksums. */
export function readTarArchive(bytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  for (;;) {
    if (offset + 512 > bytes.byteLength) {
      throw new BackupIntegrityError("Truncated tar archive");
    }
    const header = bytes.slice(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break; // end of archive
    const stored = parseOctal(header, 148, 8);
    let sum = 0;
    for (let i = 0; i < 512; i += 1) {
      sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
    }
    if (sum !== stored) {
      throw new BackupIntegrityError("Tar header checksum mismatch");
    }
    const typeflag = header[156]!;
    if (typeflag !== 0x30 && typeflag !== 0x00) {
      throw new BackupIntegrityError("Unsupported tar entry type");
    }
    const nameEnd = header.indexOf(0, 0);
    const namePart = new TextDecoder().decode(header.slice(0, nameEnd));
    const prefixNul = header.slice(345, 500).indexOf(0);
    const prefixEnd = prefixNul === -1 ? 500 : 345 + prefixNul;
    const prefixPart =
      prefixEnd > 345
        ? new TextDecoder().decode(header.slice(345, prefixEnd))
        : "";
    const name = prefixPart ? `${prefixPart}/${namePart}` : namePart;
    assertSafeArchivePath(name);
    if (files.has(name)) {
      throw new BackupIntegrityError(`Duplicate archive entry: ${name}`);
    }
    const size = parseOctal(header, 124, 12);
    if (offset + size > bytes.byteLength) {
      throw new BackupIntegrityError("Truncated tar entry data");
    }
    files.set(name, bytes.slice(offset, offset + size));
    offset += size + ((512 - (size % 512)) % 512);
  }
  return files;
}

export interface BackupArtifactInput {
  path: string;
  bytes: Uint8Array;
}

export interface BackupVaultRow {
  ownerId: string;
  name: string;
  keyVersion: number;
  ivHex: string;
  ciphertextHex: string;
  authTagHex: string;
}

export interface BackupInput {
  databaseDump: Uint8Array;
  artifacts: BackupArtifactInput[];
  vaultKeyVersions: number[];
  vaultRows: BackupVaultRow[];
  createdAt?: Date;
}

export interface BackupFileEntry {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  database: BackupFileEntry;
  artifacts: BackupFileEntry[];
  vault: BackupFileEntry & { keyVersions: number[]; rows: number };
  files: BackupFileEntry[];
}

export interface BackupArchiveContents {
  manifest: BackupManifest;
  files: Map<string, Uint8Array>;
}

const DATABASE_PATH = "database.sql";
const MANIFEST_PATH = "manifest.json";
const VAULT_PATH = "vault/envelope.json";

function entryFor(path: string, bytes: Uint8Array): BackupFileEntry {
  return { path, sha256: sha256Hex(bytes), sizeBytes: bytes.byteLength };
}

/** Build a compressed (.tar.gz) unified backup archive. */
export async function createBackupArchive(
  input: BackupInput,
): Promise<Uint8Array> {
  const createdAt = input.createdAt ?? new Date();
  const seen = new Set<string>();
  for (const artifact of input.artifacts) {
    assertSafeArchivePath(artifact.path);
    if (seen.has(artifact.path)) {
      throw new UnsafeBackupPathError(`Duplicate artifact path: ${artifact.path}`);
    }
    seen.add(artifact.path);
  }

  const envelope = new TextEncoder().encode(
    JSON.stringify({
      format: "uw-vault-envelope",
      version: 1,
      keyVersions: [...input.vaultKeyVersions].sort((a, b) => a - b),
      rows: input.vaultRows,
    }),
  );

  const databaseEntry = entryFor(DATABASE_PATH, input.databaseDump);
  const artifactEntries = input.artifacts.map((artifact) =>
    entryFor(artifact.path, artifact.bytes),
  );
  const vaultEntry = {
    ...entryFor(VAULT_PATH, envelope),
    keyVersions: [...input.vaultKeyVersions].sort((a, b) => a - b),
    rows: input.vaultRows.length,
  };
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: createdAt.toISOString(),
    database: databaseEntry,
    artifacts: artifactEntries,
    vault: vaultEntry,
    files: [databaseEntry, ...artifactEntries, vaultEntry],
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));

  const tar = createTarArchive([
    { path: DATABASE_PATH, bytes: input.databaseDump },
    ...input.artifacts.map((artifact) => ({
      path: artifact.path,
      bytes: artifact.bytes,
    })),
    { path: VAULT_PATH, bytes: envelope },
    { path: MANIFEST_PATH, bytes: manifestBytes },
  ]);
  return new Uint8Array(gzipSync(tar));
}

function gunzipArchive(archive: Uint8Array): Map<string, Uint8Array> {
  let tar: Uint8Array;
  try {
    tar = new Uint8Array(gunzipSync(archive));
  } catch {
    throw new BackupIntegrityError("Archive is not valid gzip data");
  }
  return readTarArchive(tar);
}

function parseManifest(files: Map<string, Uint8Array>): BackupManifest {
  const raw = files.get(MANIFEST_PATH);
  if (!raw) throw new BackupIntegrityError("Archive manifest is missing");
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(raw)) as BackupManifest;
  } catch {
    throw new BackupIntegrityError("Archive manifest is not valid JSON");
  }
  if (manifest.format !== BACKUP_FORMAT || manifest.version !== BACKUP_VERSION) {
    throw new BackupIntegrityError("Unsupported backup format version");
  }
  return manifest;
}

/** Read a backup archive and return its manifest plus file map. */
export async function readBackupArchive(
  archive: Uint8Array,
): Promise<BackupArchiveContents> {
  const files = gunzipArchive(archive);
  return { manifest: parseManifest(files), files };
}

/**
 * Verify a backup archive: decompresses, then checks every manifest
 * checksum against the archived bytes. Returns the manifest on success.
 */
export async function verifyBackupIntegrity(
  archive: Uint8Array,
): Promise<BackupManifest> {
  const { manifest, files } = await readBackupArchive(archive);
  for (const entry of manifest.files) {
    const bytes = files.get(entry.path);
    if (!bytes) {
      throw new BackupIntegrityError(`Archived file missing: ${entry.path}`);
    }
    if (bytes.byteLength !== entry.sizeBytes || sha256Hex(bytes) !== entry.sha256) {
      throw new BackupIntegrityError(
        `Checksum mismatch for archived file: ${entry.path}`,
      );
    }
  }
  return manifest;
}

/**
 * Walk an artifact root directory, returning safe `artifacts/<rel>` paths.
 * Symlinks and non-files are skipped so a hostile or odd directory layout
 * can never escape the archive prefix.
 */
export async function collectArtifactFiles(
  rootDir: string,
): Promise<BackupArtifactInput[]> {
  const collected: BackupArtifactInput[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await lstat(absolute);
      if (!stat.isFile()) continue;
      const rel = relative(rootDir, absolute).split(sep).join("/");
      const path = `artifacts/${rel}`;
      assertSafeArchivePath(path);
      collected.push({ path, bytes: new Uint8Array(await readFile(absolute)) });
    }
  }
  await walk(rootDir);
  collected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return collected;
}
