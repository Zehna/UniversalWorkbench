import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { closeDatabasePool, createDatabasePool } from "@uw/database";
import {
  collectArtifactFiles,
  createBackupArchive,
} from "@uw/storage";

const USAGE = `usage: backup-create [--out <path>] [--database-url <url>] [--artifacts-dir <dir>]

Creates a unified .tar.gz backup: PostgreSQL dump + artifact files +
encrypted vault envelope, with a checksummed manifest.json.
Non-interactive. Exit 0 on success, non-zero on failure.`;

function fail(message, code = 1) {
  console.error(JSON.stringify({ event: "backup-create.error", message }));
  process.exit(code);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--out" || arg === "--database-url" || arg === "--artifacts-dir") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        fail(`backup-create: ${arg} requires a value`, 2);
      }
      options[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    fail(`backup-create: unknown flag ${arg}`, 2);
  }
  return options;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const databaseUrl =
  args["database-url"] ?? process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  fail("backup-create requires --database-url (or DATABASE_URL)");
}
const artifactsDir = resolve(args["artifacts-dir"] ?? "./data/artifacts");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = resolve(args.out ?? `./uw-backup-${timestamp}.tar.gz`);

function runPgDump(url) {
  const result = spawnSync(
    "pg_dump",
    [url, "--format=plain", "--no-owner", "--no-privileges"],
    { encoding: null, maxBuffer: 512 * 1024 * 1024 },
  );
  if (result.error) {
    fail(`backup-create: pg_dump failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? Buffer.alloc(0)).toString("utf8").slice(0, 500);
    fail(`backup-create: pg_dump exited ${result.status}: ${stderr}`);
  }
  return new Uint8Array(result.stdout ?? Buffer.alloc(0));
}

const pool = createDatabasePool(databaseUrl);
try {
  const dump = runPgDump(databaseUrl);
  const artifacts = await collectArtifactFiles(artifactsDir).catch((error) => {
    fail(`backup-create: cannot read artifacts dir: ${error.message}`);
  });

  // Encrypted columns only — the keyring is never loaded, so no plaintext
  // or key material can enter the backup through this path.
  const rows = await pool
    .query(
      `select owner_id, name, key_version,
              encode(iv, 'hex') as iv,
              encode(ciphertext, 'hex') as ciphertext,
              encode(auth_tag, 'hex') as auth_tag
         from vault_secrets
        order by owner_id, name`,
    )
    .catch((error) => {
      fail(`backup-create: vault read failed: ${error.message}`);
    });
  const vaultRows = rows.rows.map((row) => ({
    ownerId: row.owner_id,
    name: row.name,
    keyVersion: row.key_version,
    ivHex: row.iv,
    ciphertextHex: row.ciphertext,
    authTagHex: row.auth_tag,
  }));
  const vaultKeyVersions = [
    ...new Set(vaultRows.map((row) => row.keyVersion)),
  ].sort((a, b) => a - b);

  const archive = await createBackupArchive({
    databaseDump: dump,
    artifacts,
    vaultKeyVersions,
    vaultRows,
  });

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, archive);
  console.log(
    JSON.stringify({
      event: "backup-create.done",
      out: outPath,
      bytes: archive.byteLength,
      artifacts: artifacts.length,
      vaultRows: vaultRows.length,
    }),
  );
} finally {
  await closeDatabasePool(pool);
}
