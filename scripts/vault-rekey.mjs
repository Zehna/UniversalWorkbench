import { closeDatabasePool, createDatabasePool } from "@uw/database";

const databaseUrl = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  console.error("vault:rekey requires DATABASE_URL (or TEST_DATABASE_URL)");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");

const pool = createDatabasePool(databaseUrl);
try {
  const db = await import("@uw/database");
  if (dryRun) {
    const stats = await db.dryRunVaultRekey(pool);
    console.log(
      JSON.stringify({
        event: "vault.rekey.dry-run",
        totalRows: stats.totalRows,
        perVersionCounts: stats.perVersionCounts,
      }),
    );
  } else {
    const result = await db.rekeyVault(pool);
    console.log(
      JSON.stringify({
        event: "vault.rekey.done",
        totalRows: result.totalRows,
        perVersionCounts: result.perVersionCounts,
        rekeyed: result.rekeyed,
      }),
    );
  }
} finally {
  await closeDatabasePool(pool);
}
