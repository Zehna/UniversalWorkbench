import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPasswordHasher,
  createAuthService,
  digestSessionToken,
} from "@uw/auth";
import {
  closeDatabasePool,
  createDatabasePool,
  createPostgresAuthRepository,
  migrateDatabase,
} from "@uw/database";
import { createApp } from "../src/app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

const SESSION_COOKIE_NAME = "uw_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const pool = createDatabasePool(databaseUrl);

let now = new Date("2026-09-16T04:00:00.000Z");

const clock = {
  now: () => new Date(now),
};

const idGenerator = {
  next: () => randomUUID(),
};

async function resetDatabaseSchemas() {
  await pool.query("drop schema if exists public cascade");
  await pool.query("drop schema if exists drizzle cascade");
  await pool.query("create schema public");
}

function createTestApp() {
  const repository = createPostgresAuthRepository(pool);
  const authService = createAuthService({
    repository,
    passwordHasher: createPasswordHasher(),
    clock,
    idGenerator,
    sessionTtlSeconds: SESSION_TTL_SECONDS,
  });

  return createApp({
    databaseReady: async () => true,
    authService,
    sessionCookie: {
      name: SESSION_COOKIE_NAME,
      secure: false,
      maxAgeSeconds: SESSION_TTL_SECONDS,
    },
  });
}

function sessionCookieFrom(response: request.Response): string {
  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const sessionCookie = cookies.find((value) =>
    value?.startsWith(`${SESSION_COOKIE_NAME}=`),
  );

  if (!sessionCookie) throw new Error("Expected session cookie");
  return sessionCookie.split(";", 1)[0] ?? "";
}

function rawSessionToken(cookie: string): string {
  const prefix = `${SESSION_COOKIE_NAME}=`;
  if (!cookie.startsWith(prefix)) throw new Error("Invalid session cookie");
  return cookie.slice(prefix.length);
}

async function setupOwner(app: ReturnType<typeof createTestApp>) {
  return request(app).post("/setup/owner").send({
    username: "owner",
    password: "correct-horse-battery-staple",
  });
}

function expectCorrelatedError(
  response: request.Response,
  status: number,
  code: string,
) {
  expect(response.status).toBe(status);
  expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(response.body.error).toMatchObject({
    code,
    requestId: response.headers["x-request-id"],
  });
}

beforeEach(async () => {
  now = new Date("2026-09-16T04:00:00.000Z");
  await resetDatabaseSchemas();
  await migrateDatabase(pool);
});

afterAll(async () => {
  await resetDatabaseSchemas();
  await closeDatabasePool(pool);
});

describe("built-in owner authentication", () => {
  it("reports uninitialized state before first-run setup", async () => {
    const app = createTestApp();

    const response = await request(app).get("/setup/status");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ initialized: false });
  });

  it("creates exactly one owner and never stores the plaintext password", async () => {
    const app = createTestApp();

    const first = await setupOwner(app);
    expect(first.status).toBe(201);
    expect(first.body.owner).toMatchObject({ username: "owner" });
    expect(first.body.owner.password).toBeUndefined();

    const stored = await pool.query<{
      password_algorithm: string;
      password_salt: string;
      password_hash: string;
    }>(
      "select password_algorithm, password_salt, password_hash from owner_accounts",
    );

    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.password_algorithm).toBe("argon2id");
    expect(stored.rows[0]?.password_salt).not.toContain(
      "correct-horse-battery-staple",
    );
    expect(stored.rows[0]?.password_hash).not.toContain(
      "correct-horse-battery-staple",
    );

    const second = await setupOwner(app);
    expect(second.status).toBe(409);
  });

  it("rejects bad credentials and creates a secure-shaped cookie for valid login", async () => {
    const app = createTestApp();
    await setupOwner(app);

    const bad = await request(app).post("/auth/login").send({
      username: "owner",
      password: "definitely-wrong-password",
    });
    expect(bad.status).toBe(401);

    const good = await request(app).post("/auth/login").send({
      username: "owner",
      password: "correct-horse-battery-staple",
    });

    expect(good.status).toBe(200);
    expect(good.body.owner).toMatchObject({ username: "owner" });

    const setCookie = good.headers["set-cookie"];
    const serialized = Array.isArray(setCookie)
      ? setCookie.join("; ")
      : String(setCookie);
    expect(serialized).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(serialized).toContain("HttpOnly");
    expect(serialized).toContain("SameSite=Lax");
    expect(serialized).toContain("Path=/");
    expect(serialized).not.toContain("Domain=");
    expect(serialized).not.toContain("Secure");

    const cookie = sessionCookieFrom(good);
    const rawToken = rawSessionToken(cookie);
    const sessions = await pool.query<{ token_hash: string }>(
      "select token_hash from auth_sessions order by created_at desc",
    );
    expect(sessions.rows.some((row) => row.token_hash === rawToken)).toBe(
      false,
    );
    expect(
      sessions.rows.some(
        (row) => row.token_hash === digestSessionToken(rawToken),
      ),
    ).toBe(true);
  });

  it("resolves a valid session, revokes it on logout, and clears the cookie", async () => {
    const app = createTestApp();
    await setupOwner(app);
    const login = await request(app).post("/auth/login").send({
      username: "owner",
      password: "correct-horse-battery-staple",
    });
    const cookie = sessionCookieFrom(login);
    const rawToken = rawSessionToken(cookie);

    const session = await request(app)
      .get("/auth/session")
      .set("Cookie", cookie);
    expect(session.status).toBe(200);
    expect(session.body.owner).toMatchObject({ username: "owner" });

    const logout = await request(app)
      .post("/auth/logout")
      .set("Cookie", cookie);
    expect(logout.status).toBe(204);
    const clearCookie = Array.isArray(logout.headers["set-cookie"])
      ? logout.headers["set-cookie"].join("; ")
      : String(logout.headers["set-cookie"]);
    expect(clearCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(clearCookie).toMatch(/Max-Age=0|Expires=/i);

    const storedSession = await pool.query<{ revoked_at: Date | null }>(
      "select revoked_at from auth_sessions where token_hash = $1",
      [digestSessionToken(rawToken)],
    );
    expect(storedSession.rows[0]?.revoked_at).not.toBeNull();

    const revoked = await request(app)
      .get("/auth/session")
      .set("Cookie", cookie);
    expect(revoked.status).toBe(401);
  });

  it("rejects expired sessions", async () => {
    const app = createTestApp();
    await setupOwner(app);
    const login = await request(app).post("/auth/login").send({
      username: "owner",
      password: "correct-horse-battery-staple",
    });
    const cookie = sessionCookieFrom(login);

    now = new Date(now.getTime() + (SESSION_TTL_SECONDS + 1) * 1000);

    const expired = await request(app)
      .get("/auth/session")
      .set("Cookie", cookie);
    expect(expired.status).toBe(401);
  });
});


describe("request-correlated auth errors", () => {
  it("includes the response request ID on setup and login 4xx envelopes", async () => {
    const app = createTestApp();

    const invalidSetup = await request(app).post("/setup/owner").send({
      username: "x",
      password: "short",
    });
    expectCorrelatedError(invalidSetup, 400, "BAD_REQUEST");

    await setupOwner(app);

    const duplicateSetup = await setupOwner(app);
    expectCorrelatedError(duplicateSetup, 409, "ALREADY_INITIALIZED");

    const invalidLogin = await request(app).post("/auth/login").send({
      username: "x",
      password: "short",
    });
    expectCorrelatedError(invalidLogin, 400, "BAD_REQUEST");

    const badCredentials = await request(app).post("/auth/login").send({
      username: "owner",
      password: "definitely-wrong-password",
    });
    expectCorrelatedError(badCredentials, 401, "INVALID_CREDENTIALS");
  });
});
