import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { closeDatabasePool, createDatabasePool } from "@uw/database";
import { readBackupArchive, verifyBackupIntegrity } from "@uw/storage";

const USAGE = `usage: backup-restore --archive <path> [--db-url <url>] [--storage-dir <dir>]

Verifies a unified backup archive against manifest.json checksums, then
restores the PostgreSQL dump into the target database and artifact files
into the storage directory. The target public schema is wiped first.
Exit 0 on success, non-zero on failure or integrity mismatch.`;

function fail(message, code = 1) {
  console.error(JSON.stringify({ event: "backup-restore.error", message }));
  process.exit(code);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--archive" || arg === "--db-url" || arg === "--storage-dir") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        fail(`backup-restore: ${arg} requires a value`, 2);
      }
      options[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    fail(`backup-restore: unknown flag ${arg}`, 2);
  }
  return options;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!args.archive) {
  fail("backup-restore requires --archive <path>", 2);
}

const databaseUrl =
  args["db-url"] ?? process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  fail("backup-restore requires --db-url (or DATABASE_URL)");
}
const storageDir = resolve(args["storage-dir"] ?? "./data/artifacts");

function runPsql(url, sql, input) {
  const argv = [url, "--quiet", "--no-psqlrc", "--variable=ON_ERROR_STOP=1"];
  if (sql) argv.push("--command", sql);
  else argv.push("--file", "-");
  const result = spawnSync("psql", argv, {
    input: input ?? null,
    encoding: null,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) {
    fail(`backup-restore: psql failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? Buffer.alloc(0)).toString("utf8").slice(0, 500);
    fail(`backup-restore: psql exited ${result.status}: ${stderr}`);
  }
  return result;
}

const archivePath = resolve(args.archive);
const archive = await readFile(archivePath).catch((error) => {
  fail(`backup-restore: cannot read archive: ${error.message}`);
});

let manifest;
try {
  manifest = await verifyBackupIntegrity(new Uint8Array(archive));
} catch (error) {
  fail(
    `backup-restore: integrity check failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}
const { files } = await readBackupArchive(new Uint8Array(archive));

const pool = createDatabasePool(databaseUrl);
try {
  // Wipe the target schemas so the restore starts from a clean slate (the
  // dump carries the drizzle bookkeeping schema alongside public).
  runPsql(
    databaseUrl,
    "drop schema public cascade; drop schema if exists drizzle cascade; create schema public;",
  );

  const dump = files.get("database.sql");
  if (!dump) fail("backup-restore: archive is missing database.sql");
  runPsql(databaseUrl, null, Buffer.from(dump));

  // Artifacts: archive paths are artifacts/<storage-key>. Containment is
  // enforced here (not just upstream in the tar reader) by resolving every
  // target and requiring it to stay inside the storage dir.
  let restoredArtifacts = 0;
  for (const entry of manifest.artifacts) {
    const bytes = files.get(entry.path);
    if (!bytes) fail(`backup-restore: archive is missing ${entry.path}`);
    if (!entry.path.startsWith("artifacts/")) {
      fail(`backup-restore: artifact outside artifacts prefix: ${entry.path}`);
    }
    const key = entry.path.slice("artifacts/".length);
    const target = resolve(storageDir, key);
    if (target !== storageDir && !target.startsWith(storageDir + sep)) {
      fail(`backup-restore: unsafe artifact path ${entry.path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    restoredArtifacts += 1;
  }

  // Vault: re-insert encrypted rows (ciphertext only, never plaintext).
  const envelopeRaw = files.get("vault/envelope.json");
  if (!envelopeRaw) fail("backup-restore: archive is missing vault/envelope.json");
  const envelope = JSON.parse(Buffer.from(envelopeRaw).toString("utf8"));
  let restoredVaultRows = 0;
  for (const row of envelope.rows ?? []) {
    await pool.query(
      `insert into vault_secrets (owner_id, name, key_version, iv, ciphertext, auth_tag, updated_at)
       values ($1, $2, $3, decode($4, 'hex'), decode($5, 'hex'), decode($6, 'hex'), now())
       on conflict (owner_id, name) do update set
         key_version = excluded.key_version,
         iv = excluded.iv,
         ciphertext = excluded.ciphertext,
         auth_tag = excluded.auth_tag,
         updated_at = now()`,
      [row.ownerId, row.name, row.keyVersion, row.ivHex, row.ciphertextHex, row.authTagHex],
    );
    restoredVaultRows += 1;
  }

  console.log(
    JSON.stringify({
      event: "backup-restore.done",
      archive: archivePath,
      manifest: manifest.version,
      createdAt: manifest.createdAt,
      restoredArtifacts,
      restoredVaultRows,
    }),
  );
} finally {
  await closeDatabasePool(pool);
}
