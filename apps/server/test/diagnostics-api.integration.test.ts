import { randomBytes } from "node:crypto";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthService } from "@uw/auth";
import {
  buildRecoveryBundle,
  createDiagnosticsRouter,
} from "../src/routes/diagnostics.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const COOKIE = "uw_session=test";
const NOW = "2026-10-08T00:00:00.000Z";

function authFor(ownerId: string | null) {
  return {
    isInitialized: vi.fn().mockResolvedValue(true),
    setupOwner: vi.fn(),
    login: vi.fn(),
    resolveSession: vi.fn().mockResolvedValue(
      ownerId ? { id: ownerId, username: "owner", createdAt: NOW } : null,
    ),
    logout: vi.fn(),
  } satisfies AuthService;
}

const sessionCookie = {
  name: "uw_session",
  secure: false,
  maxAgeSeconds: 604800,
};

interface StubPool {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

function healthyPool(): StubPool {
  return {
    query: vi.fn(async (text: string) => {
      if (/select 1/i.test(text)) return { rows: [{ "?column?": 1 }] };
      if (/__drizzle_migrations/i.test(text)) {
        return { rows: [{ id: 1 }, { id: 2 }] };
      }
      if (/execution_queue/i.test(text)) {
        return { rows: [{ pending: "3", claimed: "1" }] };
      }
      if (/sync_devices/i.test(text)) return { rows: [{ count: "2" }] };
      if (/sync_operations/i.test(text)) return { rows: [{ count: "9" }] };
      if (/vault_secrets/i.test(text)) return { rows: [{ count: "4" }] };
      if (/projects/i.test(text)) return { rows: [{ count: "5" }] };
      if (/documents/i.test(text)) return { rows: [{ count: "6" }] };
      if (/artifacts/i.test(text)) return { rows: [{ count: "7" }] };
      return { rows: [] };
    }),
  };
}

function diagnosticsApp(options: {
  ownerId: string | null;
  pool?: StubPool;
  artifactsDir?: string;
  databaseReady?: boolean;
}): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/diagnostics",
    createDiagnosticsRouter({
      databaseReady: async () => options.databaseReady ?? true,
      ...(options.pool ? { pool: options.pool as never } : {}),
      ...(options.artifactsDir ? { artifactsDir: options.artifactsDir } : {}),
      authService: authFor(options.ownerId),
      sessionCookie,
    }),
  );
  return app;
}

let dir: string;
let savedKeyring: string | undefined;
let savedLegacy: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "uw-diag-"));
  savedKeyring = process.env.VAULT_MASTER_KEYS;
  savedLegacy = process.env.VAULT_MASTER_KEY;
  delete process.env.VAULT_MASTER_KEYS;
  delete process.env.VAULT_MASTER_KEY;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (savedKeyring === undefined) delete process.env.VAULT_MASTER_KEYS;
  else process.env.VAULT_MASTER_KEYS = savedKeyring;
  if (savedLegacy === undefined) delete process.env.VAULT_MASTER_KEY;
  else process.env.VAULT_MASTER_KEY = savedLegacy;
});

describe("diagnostics API", () => {
  it("answers the liveness probe without authentication", async () => {
    const app = diagnosticsApp({ ownerId: null });
    const res = await request(app).get("/api/diagnostics/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("reports ready when database and storage are healthy", async () => {
    const app = diagnosticsApp({
      ownerId: null,
      pool: healthyPool(),
      artifactsDir: dir,
    });
    const res = await request(app).get("/api/diagnostics/readiness");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.checks.database).toBe("ok");
    expect(res.body.checks.storage).toBe("ok");
    expect(res.body.checks.vault.status).toBe("degraded");
  });

  it("reports 503 when the database is unreachable", async () => {
    const app = diagnosticsApp({
      ownerId: null,
      pool: {
        query: vi.fn(async () => {
          throw new Error("connection refused");
        }),
      },
      artifactsDir: dir,
    });
    const res = await request(app).get("/api/diagnostics/readiness");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    expect(res.body.checks.database).toBe("error");
  });

  it("reports 503 when storage is not writable", async () => {
    const app = diagnosticsApp({
      ownerId: null,
      pool: healthyPool(),
      artifactsDir: join(dir, "missing-dir"),
    });
    const res = await request(app).get("/api/diagnostics/readiness");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    expect(res.body.checks.storage).toBe("error");
  });

  it("requires authentication for the recovery bundle", async () => {
    const app = diagnosticsApp({
      ownerId: null,
      pool: healthyPool(),
      artifactsDir: dir,
    });
    const res = await request(app).get("/api/diagnostics/recovery-bundle");
    expect(res.status).toBe(401);
  });

  it("exports a redacted recovery bundle for the owner", async () => {
    const canary = `canary-secret-${randomBytes(8).toString("hex")}`;
    process.env.VAULT_MASTER_KEYS = `1:${randomBytes(32).toString("base64")}`;
    const app = diagnosticsApp({
      ownerId: OWNER_ID,
      pool: healthyPool(),
      artifactsDir: dir,
    });
    const res = await request(app)
      .get("/api/diagnostics/recovery-bundle")
      .set("Cookie", COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.bundle).toMatchObject({
      format: "uw-recovery-bundle",
      version: 1,
    });
    expect(res.body.bundle.sections.database.migrationsApplied).toEqual([1, 2]);
    expect(res.body.bundle.sections.queue.pending).toBe(3);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("VAULT_MASTER_KEYS");
  });

  it("redacts secret-like keys and known secrets in bundle sections", () => {
    const canary = `planted-${randomBytes(8).toString("hex")}`;
    const bundle = buildRecoveryBundle({
      generatedAt: NOW,
      sections: {
        database: { reachable: true },
        custom: {
          apiKey: "live-key",
          nested: { token: canary, count: 3 },
          message: `failed with ${canary}`,
        },
      },
      knownSecrets: [canary],
    });
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("live-key");
    expect(serialized).not.toContain(canary);
    expect(serialized).toContain("[REDACTED]");
  });
});
