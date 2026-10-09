import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TextEncoder } from "node:util";
import { fileURLToPath } from "node:url";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const backupCreate = join(here, "backup-create.mjs");
const backupRestore = join(here, "backup-restore.mjs");

const USAGE = `usage: test-restore-drill [--src-db-url <url>] [--dst-db-url <url>] [--keep]

End-to-end disaster-recovery drill: seed sample data -> backup -> restore
into a clean database -> assert integrity. Requires local PostgreSQL with
createdb privilege and pg_dump/psql on PATH. Exit 0 on success.`;

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--keep") {
      options.keep = true;
      continue;
    }
    if (arg === "--src-db-url" || arg === "--dst-db-url") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        console.error(`test-restore-drill: ${arg} requires a value`);
        process.exit(2);
      }
      options[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    console.error(`test-restore-drill: unknown flag ${arg}`);
    process.exit(2);
  }
  return options;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const socketHost = "/var/run/postgresql";
const osUser = process.env.USER ?? "postgres";
const srcDbUrl =
  args["src-db-url"] ??
  process.env.DRILL_SRC_DATABASE_URL ??
  `postgresql://${osUser}@/uw_drill_src?host=${socketHost}`;
const dstDbUrl =
  args["dst-db-url"] ??
  process.env.DRILL_DST_DATABASE_URL ??
  `postgresql://${osUser}@/uw_drill_dst?host=${socketHost}`;

// Ephemeral keyring for the drill only; restore itself never needs it.
process.env.VAULT_MASTER_KEYS = `1:${randomBytes(32).toString("base64")}`;
delete process.env.VAULT_MASTER_KEY;

const checks = [];
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ name, pass });
  if (!pass) {
    console.error(
      JSON.stringify({ event: "restore-drill.check-failed", name, actual, expected }),
    );
  }
}

function runCli(script, cliArgs, label) {
  const result = spawnSync(process.execPath, [script, ...cliArgs], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(
      JSON.stringify({
        event: "restore-drill.cli-failed",
        label,
        status: result.status,
        stderr: (result.stderr ?? "").slice(0, 500),
      }),
    );
    process.exit(1);
  }
  return result;
}

const db = await import("@uw/database");
const auth = await import("@uw/auth");
const core = await import("@uw/core");
const documents = await import("@uw/documents");
const artifacts = await import("@uw/artifacts");
const shared = await import("@uw/shared");
const storage = await import("@uw/storage");

const workdir = await mkdtemp(join(tmpdir(), "uw-restore-drill-"));
const srcArtifactsDir = join(workdir, "src-artifacts");
const dstArtifactsDir = join(workdir, "dst-artifacts");
const archivePath = join(workdir, "drill-backup.tar.gz");

function servicesFor(pool) {
  const clock = new shared.SystemClock();
  const idGenerator = new shared.UuidGenerator();
  const audit = db.createPostgresAuditRepository(pool);
  return {
    authService: auth.createAuthService({
      repository: db.createPostgresAuthRepository(pool),
      passwordHasher: auth.createPasswordHasher(),
      clock,
      idGenerator,
      sessionTtlSeconds: 3600,
    }),
    projectService: core.createProjectService({
      projects: db.createPostgresProjectRepository(pool),
      audit,
      clock,
      idGenerator,
    }),
    documentService: documents.createDocumentService({
      documents: db.createPostgresDocumentRepository(pool),
      audit,
      clock,
      idGenerator,
    }),
  };
}

async function resetDatabase(url) {
  const pool = db.createDatabasePool(url);
  try {
    // Drop the drizzle bookkeeping schema too: otherwise a re-migrate is a
    // no-op and the "clean" database silently has no tables.
    await pool.query(
      "drop schema public cascade; drop schema if exists drizzle cascade; create schema public;",
    );
    await db.migrateDatabase(pool);
  } finally {
    await db.closeDatabasePool(pool);
  }
}

let failed = false;
try {
  // 1. Clean slate on both databases.
  await resetDatabase(srcDbUrl);
  await resetDatabase(dstDbUrl);

  // 2. Seed the source: owner -> project -> note -> artifact -> vault secret.
  const srcPool = db.createDatabasePool(srcDbUrl);
  let ownerId;
  let projectId;
  let documentId;
  let artifactId;
  let artifactSha;
  const vaultPlaintext = `drill-secret-${randomUUID()}`;
  try {
    const services = servicesFor(srcPool);
    const { owner } = await services.authService.setupOwner({
      username: "drill-owner",
      password: "drill-password-123",
    });
    ownerId = owner.id;
    const project = await services.projectService.create(
      ownerId,
      { name: "Drill Project" },
      randomUUID(),
    );
    projectId = project.id;
    const note = await services.documentService.createNote(
      ownerId,
      projectId,
      { title: "Drill Note", body: "disaster recovery test body" },
      randomUUID(),
    );
    documentId = note.document.id;

    const artifactService = artifacts.createArtifactService({
      artifacts: db.createPostgresArtifactRepository(srcPool),
      storage: storage.createLocalFilesystemStorage(srcArtifactsDir),
      audit: db.createPostgresAuditRepository(srcPool),
      clock: new shared.SystemClock(),
      idGenerator: new shared.UuidGenerator(),
    });
    const payload = new TextEncoder().encode(
      JSON.stringify({ drill: true, n: 7 }),
    );
    const artifact = await artifactService.create(
      ownerId,
      projectId,
      {
        type: "drill-output",
        mimeType: "application/json",
        bytes: payload,
        metadata: {},
      },
      randomUUID(),
    );
    artifactId = artifact.id;
    artifactSha = artifact.checksumSha256;

    const vault = db.createVaultStore(srcPool);
    await vault.put(ownerId, "drill-key", vaultPlaintext);
  } finally {
    await db.closeDatabasePool(srcPool);
  }

  // 3. Back up via the real CLI.
  runCli(
    backupCreate,
    [
      "--out", archivePath,
      "--database-url", srcDbUrl,
      "--artifacts-dir", srcArtifactsDir,
    ],
    "backup-create",
  );

  // 4. Negative control: a tampered archive must fail the restore.
  const rawArchive = await readFile(archivePath);
  const tampered = Buffer.from(rawArchive);
  tampered[Math.floor(tampered.length / 2)] ^= 0xff;
  const tamperedPath = join(workdir, "tampered.tar.gz");
  await writeFile(tamperedPath, tampered);
  const tamperResult = spawnSync(
    process.execPath,
    [backupRestore, "--archive", tamperedPath, "--db-url", dstDbUrl, "--storage-dir", dstArtifactsDir],
    { encoding: "utf8" },
  );
  check("tampered archive is rejected", tamperResult.status !== 0, true);

  // 5. Restore into the clean target via the real CLI.
  runCli(
    backupRestore,
    [
      "--archive", archivePath,
      "--db-url", dstDbUrl,
      "--storage-dir", dstArtifactsDir,
    ],
    "backup-restore",
  );

  // 6. Assert integrity on the target.
  const dstPool = db.createDatabasePool(dstDbUrl);
  try {
    const project = await dstPool.query(
      "select id, owner_id, name from projects where id = $1",
      [projectId],
    );
    check("project restored", project.rows[0]?.name, "Drill Project");
    check("project owner preserved", project.rows[0]?.owner_id, ownerId);

    const doc = await dstPool.query(
      `select d.id, d.project_id, r.content from documents d
       join document_revisions r on r.id = d.current_revision_id
       where d.id = $1`,
      [documentId],
    );
    check("note body restored", doc.rows[0]?.content?.body, "disaster recovery test body");
    check("note relational link intact", doc.rows[0]?.project_id, projectId);

    const artifactRow = await dstPool.query(
      "select id, project_id, checksum_sha256, size_bytes from artifacts where id = $1",
      [artifactId],
    );
    check("artifact record restored", artifactRow.rows[0]?.checksum_sha256, artifactSha);
    check("artifact relational link intact", artifactRow.rows[0]?.project_id, projectId);

    const restoredBytes = await readFile(
      join(dstArtifactsDir, projectId, artifactId, artifactSha),
    );
    const restoredSha = createHash("sha256").update(restoredBytes).digest("hex");
    check("artifact bytes checksum matches", restoredSha, artifactSha);

    // Vault: encrypted rows identical without any key; plaintext round-trips with the drill key.
    const srcProbe = db.createDatabasePool(srcDbUrl);
    let srcRows;
    let dstRows;
    try {
      const columns =
        "owner_id, name, key_version, encode(iv,'hex') iv, encode(ciphertext,'hex') ciphertext, encode(auth_tag,'hex') auth_tag";
      srcRows = (
        await srcProbe.query(`select ${columns} from vault_secrets order by owner_id, name`)
      ).rows;
      dstRows = (
        await dstPool.query(`select ${columns} from vault_secrets order by owner_id, name`)
      ).rows;
    } finally {
      await db.closeDatabasePool(srcProbe);
    }
    check("vault encrypted rows identical", dstRows, srcRows);

    const vault = db.createVaultStore(dstPool);
    check("vault plaintext round-trips", await vault.get(ownerId, "drill-key"), vaultPlaintext);
  } finally {
    await db.closeDatabasePool(dstPool);
  }

  const failedChecks = checks.filter((entry) => !entry.pass);
  failed = failedChecks.length > 0;
  console.log(
    JSON.stringify({
      event: failed ? "restore-drill.failed" : "restore-drill.done",
      passed: checks.length - failedChecks.length,
      failed: failedChecks.length,
      checks: checks.map((entry) => ({ name: entry.name, pass: entry.pass })),
    }),
  );
  if (failed) process.exitCode = 1;
} finally {
  if (!args.keep) {
    await rm(workdir, { recursive: true, force: true });
  }
}
