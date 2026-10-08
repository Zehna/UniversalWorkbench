import { randomUUID } from "node:crypto";
import {
  closeDatabasePool,
  createDatabasePool,
  createPostgresAuditRepository,
} from "@uw/database";

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
        failed: result.failed,
      }),
    );
    // Ownership audit for the rekey event. Best-effort: the rekey itself
    // already happened, so a failed audit write warns instead of failing.
    try {
      const audit = createPostgresAuditRepository(pool);
      await audit.record({
        id: randomUUID(),
        actorId: "operator",
        action: "vault.rekey",
        targetType: "vault-keyring",
        traceId: randomUUID(),
        metadata: {
          totalRows: result.totalRows,
          rekeyed: result.rekeyed,
          failed: result.failed,
        },
        createdAt: new Date(),
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "vault.rekey.audit-warning",
          message:
            error instanceof Error ? error.message : "audit record failed",
        }),
      );
    }
    if (result.failed > 0) {
      console.error(
        JSON.stringify({
          event: "vault.rekey.failed",
          totalRows: result.totalRows,
          rekeyed: result.rekeyed,
          failed: result.failed,
        }),
      );
      process.exitCode = 1;
    }
  }
} finally {
  await closeDatabasePool(pool);
}
