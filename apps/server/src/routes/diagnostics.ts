import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Router } from "express";
import type { AuthService } from "@uw/auth";
import type { createVaultStore } from "@uw/database";
import { getVaultKeyringStatus } from "@uw/database";
import { redactSecrets } from "@uw/shared";
import { requireOwner, type SessionCookieConfig } from "../middleware/auth.js";
import { HttpError, mapDomainError } from "../middleware/validate.js";

type DiagnosticsPool = Parameters<typeof createVaultStore>[0];

export interface DiagnosticsRouterDependencies {
  databaseReady(): Promise<boolean>;
  pool?: DiagnosticsPool;
  artifactsDir?: string;
  authService?: AuthService;
  sessionCookie?: SessionCookieConfig;
}

export type CheckState = "ok" | "error" | "unknown" | "degraded";

export interface VaultCheck {
  status: CheckState;
  configured: boolean;
  newestVersion: number | null;
}

export interface ReadinessChecks {
  database: CheckState;
  storage: CheckState;
  vault: VaultCheck;
}

async function checkDatabase(
  deps: DiagnosticsRouterDependencies,
): Promise<CheckState> {
  try {
    if (deps.pool) {
      await deps.pool.query("select 1");
      return "ok";
    }
    return (await deps.databaseReady()) ? "ok" : "error";
  } catch {
    return "error";
  }
}

async function checkStorage(
  deps: DiagnosticsRouterDependencies,
): Promise<CheckState> {
  if (!deps.artifactsDir) return "unknown";
  const probe = join(deps.artifactsDir, `.diagnostics-probe-${randomUUID()}`);
  try {
    await writeFile(probe, "diagnostics", { flag: "wx" });
    await rm(probe, { force: true });
    return "ok";
  } catch {
    await rm(probe, { force: true }).catch(() => undefined);
    return "error";
  }
}

function checkVault(): VaultCheck {
  try {
    const status = getVaultKeyringStatus();
    return status.configured
      ? { status: "ok", configured: true, newestVersion: status.newestVersion }
      : { status: "degraded", configured: false, newestVersion: null };
  } catch {
    return { status: "degraded", configured: false, newestVersion: null };
  }
}

export async function collectReadiness(
  deps: DiagnosticsRouterDependencies,
): Promise<ReadinessChecks> {
  const [database, storage] = await Promise.all([
    checkDatabase(deps),
    checkStorage(deps),
  ]);
  return { database, storage, vault: checkVault() };
}

export function readinessStatus(checks: ReadinessChecks): boolean {
  // Fail closed: storage must be positively verified, not merely
  // non-failing — an unverified ("unknown") artifacts dir must not serve.
  return checks.database === "ok" && checks.storage === "ok";
}

async function countOrNull(
  pool: DiagnosticsPool | undefined,
  sql: string,
): Promise<number | null> {
  if (!pool) return null;
  try {
    const result = await pool.query(sql);
    const raw = result.rows[0] as Record<string, unknown> | undefined;
    const value = raw ? Object.values(raw)[0] : undefined;
    const parsed = typeof value === "string" ? Number(value) : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function migrationIds(
  pool: DiagnosticsPool | undefined,
): Promise<number[] | null> {
  if (!pool) return null;
  try {
    const result = await pool.query(
      "select id from drizzle.__drizzle_migrations order by id",
    );
    return (result.rows as { id: number }[]).map((row) => Number(row.id));
  } catch {
    return null;
  }
}

export interface RecoveryBundleSections {
  database?: Record<string, unknown>;
  storage?: Record<string, unknown>;
  vault?: Record<string, unknown>;
  queue?: Record<string, unknown>;
  sync?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  [key: string]: Record<string, unknown> | undefined;
}

export interface RecoveryBundle {
  format: "uw-recovery-bundle";
  version: 1;
  generatedAt: string;
  sections: Record<string, unknown>;
}

/**
 * Assemble the recovery bundle and scrub it: secret-like keys are
 * redacted and every `knownSecrets` occurrence is scrubbed from all
 * strings, regardless of field name.
 */
export function buildRecoveryBundle(input: {
  generatedAt: string;
  sections: RecoveryBundleSections;
  knownSecrets?: readonly string[];
}): RecoveryBundle {
  const sections = redactSecrets(input.sections, input.knownSecrets) as Record<
    string,
    unknown
  >;
  return {
    format: "uw-recovery-bundle",
    version: 1,
    generatedAt: input.generatedAt,
    sections,
  };
}

export async function collectRecoveryBundle(
  deps: DiagnosticsRouterDependencies,
): Promise<RecoveryBundle> {
  const { pool } = deps;
  const checks = await collectReadiness(deps);
  const queueRow = await (async () => {
    if (!pool) return null;
    try {
      const result = await pool.query(
        `select count(*) filter (where lease_owner is null) as pending,
                count(*) filter (where lease_owner is not null) as claimed
           from execution_queue`,
      );
      const row = result.rows[0] as
        { pending: string; claimed: string } | undefined;
      return row
        ? { pending: Number(row.pending), claimed: Number(row.claimed) }
        : null;
    } catch {
      return null;
    }
  })();

  return buildRecoveryBundle({
    generatedAt: new Date().toISOString(),
    sections: {
      database: {
        reachable: checks.database === "ok",
        migrationsApplied: await migrationIds(pool),
      },
      storage: { writable: checks.storage },
      vault: {
        configured: checks.vault.configured,
        newestVersion: checks.vault.newestVersion,
        rows: await countOrNull(
          pool,
          "select count(*) as count from vault_secrets",
        ),
      },
      queue: queueRow ?? { pending: null, claimed: null },
      sync: {
        devices: await countOrNull(
          pool,
          "select count(*) as count from sync_devices",
        ),
        operations: await countOrNull(
          pool,
          "select count(*) as count from sync_operations",
        ),
      },
      tables: {
        projects: await countOrNull(
          pool,
          "select count(*) as count from projects",
        ),
        documents: await countOrNull(
          pool,
          "select count(*) as count from documents",
        ),
        artifacts: await countOrNull(
          pool,
          "select count(*) as count from artifacts",
        ),
      },
      environment: {
        service: "universal-workbench",
        node: process.version,
        platform: process.platform,
      },
    },
  });
}

export function createDiagnosticsRouter(deps: DiagnosticsRouterDependencies) {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", service: "universal-workbench" });
  });

  router.get("/readiness", async (_req, res, next) => {
    try {
      const checks = await collectReadiness(deps);
      if (!readinessStatus(checks)) {
        res.status(503).json({ status: "not_ready", checks });
        return;
      }
      res.status(200).json({ status: "ready", checks });
    } catch (error) {
      next(error);
    }
  });

  const canAuthenticate = Boolean(deps.authService && deps.sessionCookie);
  const gate =
    deps.authService && deps.sessionCookie
      ? requireOwner(deps.authService, deps.sessionCookie)
      : (_req: unknown, _res: unknown, next: (error?: unknown) => void) =>
          next(
            new HttpError(
              503,
              "DIAGNOSTICS_UNAVAILABLE",
              "Recovery bundle requires authentication",
            ),
          );

  router.get("/recovery-bundle", gate, async (_req, res, next) => {
    try {
      if (!canAuthenticate) {
        throw new HttpError(
          503,
          "DIAGNOSTICS_UNAVAILABLE",
          "Recovery bundle requires authentication",
        );
      }
      const bundle = await collectRecoveryBundle(deps);
      res.status(200).json({ bundle });
    } catch (error) {
      next(mapDomainError(error));
    }
  });

  return router;
}
