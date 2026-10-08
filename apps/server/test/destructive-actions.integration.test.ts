import { randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthService } from "@uw/auth";
import {
  createProjectService,
  ProjectNotFoundError,
  type AuditRepository,
  type ProjectService,
} from "@uw/core";
import { SystemClock, UuidGenerator } from "@uw/shared";
import { createVaultStore } from "@uw/database";
import type { Pool } from "pg";
import { createProjectsRouter } from "../src/routes/projects.js";
import { createVaultRouter } from "../src/routes/vault.js";

const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PROJECT_ID = "99999999-9999-4999-8999-999999999999";
const COOKIE = "uw_session=test";
const NOW = "2026-10-08T00:00:00.000Z";

function authFor(ownerId: string | null) {
  return {
    isInitialized: vi.fn().mockResolvedValue(true),
    setupOwner: vi.fn(),
    login: vi.fn(),
    resolveSession: vi.fn().mockResolvedValue(
      ownerId
        ? { id: ownerId, username: "owner", createdAt: NOW }
        : null,
    ),
    logout: vi.fn(),
  } satisfies AuthService;
}

const sessionCookie = {
  name: "uw_session",
  secure: false,
  maxAgeSeconds: 604800,
};

// Mirrors createApp's 4xx envelope so tests can assert on error codes.
function jsonErrors(app: express.Express): void {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const err = error as { status?: unknown; code?: unknown };
      const status =
        typeof err?.status === "number" ? err.status : 500;
      const code = typeof err?.code === "string" ? err.code : "INTERNAL_ERROR";
      res.status(status).json({ error: { code } });
    },
  );
}

const projectFixture = {
  id: PROJECT_ID,
  ownerId: OWNER_A,
  name: "Research",
  description: null,
  schemaVersion: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

function projectServiceMock() {
  const get = vi.fn(async (ownerId: string, projectId: string) => {
    if (ownerId !== OWNER_A || projectId !== PROJECT_ID) {
      throw new ProjectNotFoundError(projectId);
    }
    return projectFixture;
  });
  const remove = vi.fn(async (ownerId: string, projectId: string) => {
    if (ownerId !== OWNER_A || projectId !== PROJECT_ID) {
      throw new ProjectNotFoundError(projectId);
    }
    return { id: projectId };
  });
  const service = {
    create: vi.fn(),
    list: vi.fn(),
    get,
    update: vi.fn(async (ownerId: string, projectId: string) => {
      if (ownerId !== OWNER_A || projectId !== PROJECT_ID) {
        throw new ProjectNotFoundError(projectId);
      }
      return projectFixture;
    }),
    delete: remove,
  } as unknown as ProjectService;
  return { service, get, remove };
}

function projectsApp(
  ownerId: string | null,
  service: ProjectService,
): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    "/projects",
    createProjectsRouter({
      authService: authFor(ownerId),
      sessionCookie,
      projectService: service,
    }),
  );
  jsonErrors(app);
  return app;
}

describe("project destructive safeguards", () => {
  it("conceals another owner's project as 404 on read, update, and delete", async () => {
    const { service, remove } = projectServiceMock();
    const app = projectsApp(OWNER_B, service);

    const get = await request(app)
      .get(`/projects/${PROJECT_ID}`)
      .set("Cookie", COOKIE);
    expect(get.status).toBe(404);
    expect(get.body.error.code).toBe("NOT_FOUND");

    const patch = await request(app)
      .patch(`/projects/${PROJECT_ID}`)
      .set("Cookie", COOKIE)
      .send({ name: "hijacked" });
    expect(patch.status).toBe(404);
    expect(patch.body.error.code).toBe("NOT_FOUND");

    const del = await request(app)
      .delete(`/projects/${PROJECT_ID}`)
      .set("Cookie", COOKIE)
      .send({ confirm: PROJECT_ID });
    expect(del.status).toBe(404);
    expect(del.body.error.code).toBe("NOT_FOUND");
    expect(remove).not.toHaveBeenCalled();
  });

  it("requires matching confirmation to delete a project", async () => {
    const { service, remove } = projectServiceMock();
    const app = projectsApp(OWNER_A, service);

    const missing = await request(app)
      .delete(`/projects/${PROJECT_ID}`)
      .set("Cookie", COOKIE)
      .send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("CONFIRMATION_REQUIRED");

    const wrong = await request(app)
      .delete(`/projects/${PROJECT_ID}`)
      .set("Cookie", COOKIE)
      .send({ confirm: "something-else" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("CONFIRMATION_REQUIRED");
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes with matching confirmation and reports the deletion", async () => {
    const { service, remove } = projectServiceMock();
    const app = projectsApp(OWNER_A, service);

    const del = await request(app)
      .delete(`/projects/${PROJECT_ID}`)
      .set("Cookie", COOKIE)
      .send({ confirm: PROJECT_ID });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]?.[0]).toBe(OWNER_A);
    expect(remove.mock.calls[0]?.[1]).toBe(PROJECT_ID);
  });

  it("records a project.delete audit entry through the service", async () => {
    const records: unknown[] = [];
    const audit = {
      record: vi.fn(async (input: unknown) => {
        records.push(input);
      }),
    } satisfies AuditRepository;
    const store = new Map<string, typeof projectFixture>();
    store.set(`${OWNER_A}:${PROJECT_ID}`, projectFixture);
    const service = createProjectService({
      projects: {
        create: vi.fn(),
        list: vi.fn(async () => []),
        get: vi.fn(async (ownerId: string, projectId: string) =>
          ownerId === OWNER_A ? (store.get(`${ownerId}:${projectId}`) ?? null) : null,
        ),
        update: vi.fn(),
        remove: vi.fn(async (ownerId: string, projectId: string) => {
          const key = `${ownerId}:${projectId}`;
          if (!store.has(key)) return false;
          store.delete(key);
          return true;
        }),
      },
      audit,
      clock: new SystemClock(),
      idGenerator: new UuidGenerator(),
    });

    await service.delete(OWNER_A, PROJECT_ID, "trace-1");
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0]?.[0]).toMatchObject({
      actorId: OWNER_A,
      projectId: PROJECT_ID,
      action: "project.delete",
      targetType: "project",
      targetId: PROJECT_ID,
      traceId: "trace-1",
    });

    await expect(service.delete(OWNER_A, PROJECT_ID, "trace-2")).rejects.toThrow(
      ProjectNotFoundError,
    );
    await expect(
      service.delete(OWNER_B, PROJECT_ID, "trace-3"),
    ).rejects.toThrow(ProjectNotFoundError);
  });
});

interface VaultRow {
  key_version: number;
  iv: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
}

function stubPool() {
  const rows = new Map<string, VaultRow>();
  const query = vi.fn(async (text: string, params: unknown[]) => {
    if (text.startsWith("insert into vault_secrets")) {
      const [ownerId, name, version, iv, ciphertext, authTag] = params as [
        string,
        string,
        number,
        Buffer,
        Buffer,
        Buffer,
      ];
      rows.set(`${ownerId}:${name}`, {
        key_version: version,
        iv,
        ciphertext,
        auth_tag: authTag,
      });
      return { rows: [] };
    }
    if (text.startsWith("select key_version")) {
      const row = rows.get(`${params[0] as string}:${params[1] as string}`);
      return { rows: row ? [row] : [] };
    }
    if (text.startsWith("delete from vault_secrets")) {
      rows.delete(`${params[0] as string}:${params[1] as string}`);
      return { rows: [] };
    }
    if (text.startsWith("select name from vault_secrets")) {
      const prefix = `${params[0] as string}:`;
      return {
        rows: [...rows.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ name: key.slice(prefix.length) })),
      };
    }
    throw new Error(`unexpected query: ${text}`);
  });
  return { pool: { query } as unknown as Pool, rows };
}

let savedKeyring: string | undefined;
let savedLegacy: string | undefined;

function vaultApp(
  ownerId: string | null,
  pool: Pool,
  audit: AuditRepository,
): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    "/vault",
    createVaultRouter({
      authService: authFor(ownerId),
      sessionCookie,
      pool,
      audit,
    }),
  );
  jsonErrors(app);
  return app;
}

describe("vault destructive safeguards", () => {
  beforeEach(() => {
    savedKeyring = process.env.VAULT_MASTER_KEYS;
    savedLegacy = process.env.VAULT_MASTER_KEY;
    process.env.VAULT_MASTER_KEYS = `1:${randomBytes(32).toString("base64")}`;
    delete process.env.VAULT_MASTER_KEY;
  });

  afterEach(() => {
    if (savedKeyring === undefined) delete process.env.VAULT_MASTER_KEYS;
    else process.env.VAULT_MASTER_KEYS = savedKeyring;
    if (savedLegacy === undefined) delete process.env.VAULT_MASTER_KEY;
    else process.env.VAULT_MASTER_KEY = savedLegacy;
  });

  it("conceals another owner's secret as 404 without recording an audit", async () => {
    const { pool } = stubPool();
    const audit = {
      record: vi.fn(async (_input: unknown) => {}),
    } satisfies AuditRepository;
    const store = createVaultStore(pool);
    await store.put(OWNER_A, "private", "owner-a-value");

    const app = vaultApp(OWNER_B, pool, audit);
    const del = await request(app)
      .delete("/vault/private?confirm=private")
      .set("Cookie", COOKIE);
    expect(del.status).toBe(404);
    expect(del.body.error.code).toBe("NOT_FOUND");
    expect(audit.record).not.toHaveBeenCalled();
    // Owner A still sees the secret.
    expect(await store.get(OWNER_A, "private")).toBe("owner-a-value");
  });

  it("requires matching confirmation to delete a vault secret", async () => {
    const { pool } = stubPool();
    const audit = {
      record: vi.fn(async (_input: unknown) => {}),
    } satisfies AuditRepository;
    const store = createVaultStore(pool);
    await store.put(OWNER_A, "mykey", "shh");

    const app = vaultApp(OWNER_A, pool, audit);
    const missing = await request(app)
      .delete("/vault/mykey")
      .set("Cookie", COOKIE);
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("CONFIRMATION_REQUIRED");

    const wrong = await request(app)
      .delete("/vault/mykey?confirm=other")
      .set("Cookie", COOKIE);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("CONFIRMATION_REQUIRED");
    expect(audit.record).not.toHaveBeenCalled();
    expect(await store.get(OWNER_A, "mykey")).toBe("shh");
  });

  it("deletes with confirmation and records a vault.secret.delete audit", async () => {
    const { pool } = stubPool();
    const audit = {
      record: vi.fn(async (_input: unknown) => {}),
    } satisfies AuditRepository;
    const store = createVaultStore(pool);
    await store.put(OWNER_A, "mykey", "shh");

    const app = vaultApp(OWNER_A, pool, audit);
    const del = await request(app)
      .delete("/vault/mykey?confirm=mykey")
      .set("Cookie", COOKIE);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0]?.[0]).toMatchObject({
      actorId: OWNER_A,
      action: "vault.secret.delete",
      targetType: "vault-secret",
      targetId: "mykey",
    });
    expect(await store.get(OWNER_A, "mykey")).toBeNull();
  });
});
