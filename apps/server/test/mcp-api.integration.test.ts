import { randomUUID } from "node:crypto";
import type { AuthService } from "@uw/auth";
import { createInMemoryMcpServerRepository } from "@uw/database";
import type { McpServerConfig } from "@uw/contracts";
import { createToolRegistry, type McpToolDefinition } from "@uw/tools";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";
const COOKIE = "uw_session=valid";
const NOW = "2026-09-26T00:00:00.000Z";

function authServiceFor(authenticated = true) {
  return {
    isInitialized: vi.fn().mockResolvedValue(true),
    setupOwner: vi.fn(),
    login: vi.fn(),
    resolveSession: vi
      .fn()
      .mockResolvedValue(
        authenticated ? { id: OWNER, username: "owner", createdAt: NOW } : null,
      ),
    logout: vi.fn(),
  } satisfies AuthService;
}

function setup(options?: {
  authenticated?: boolean;
  discoverTools?: (server: McpServerConfig) => Promise<McpToolDefinition[]>;
}) {
  const authService = authServiceFor(options?.authenticated ?? true);
  const mcpServers = createInMemoryMcpServerRepository();
  const registry = createToolRegistry();
  const discoverTools =
    options?.discoverTools ??
    (async () => [
      {
        name: "search",
        description: "search the web",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
  const app = createApp({
    databaseReady: async () => true,
    authService,
    sessionCookie: { name: "uw_session", secure: false, maxAgeSeconds: 604800 },
    toolRegistry: registry,
    mcpServers,
    mcpDiscoverTools: discoverTools,
  });
  return { app, mcpServers, registry };
}

function stdioBody(name = "my server") {
  return {
    name,
    transportConfig: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "mcp-server"],
    },
    secretRefs: [],
  };
}

describe("mcp server management api", () => {
  it("requires authentication on all mcp routes", async () => {
    const { app } = setup({ authenticated: false });
    const serverId = randomUUID();
    await expect(
      request(app).get(`/api/projects/${PROJECT}/mcp-servers`),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      request(app)
        .post(`/api/projects/${PROJECT}/mcp-servers`)
        .send(stdioBody()),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      request(app).get(`/api/projects/${PROJECT}/mcp-servers/${serverId}`),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      request(app)
        .patch(`/api/projects/${PROJECT}/mcp-servers/${serverId}`)
        .send({ name: "x" }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      request(app).delete(`/api/projects/${PROJECT}/mcp-servers/${serverId}`),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      request(app).post(
        `/api/projects/${PROJECT}/mcp-servers/${serverId}/sync`,
      ),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("runs a full CRUD cycle for an mcp server configuration", async () => {
    const { app } = setup();

    const created = await request(app)
      .post(`/api/projects/${PROJECT}/mcp-servers`)
      .set("Cookie", COOKIE)
      .send(stdioBody("alpha"));
    expect(created.status).toBe(201);
    expect(created.body.server).toMatchObject({
      name: "alpha",
      enabled: true,
    });
    expect(created.body.server.id).toBeDefined();
    expect(created.body.server.projectId).toBe(PROJECT);
    const serverId = created.body.server.id as string;

    const listed = await request(app)
      .get(`/api/projects/${PROJECT}/mcp-servers`)
      .set("Cookie", COOKIE);
    expect(listed.status).toBe(200);
    expect(listed.body.servers).toHaveLength(1);
    expect(listed.body.servers[0].id).toBe(serverId);

    const other = await request(app)
      .get(`/api/projects/${OTHER_PROJECT}/mcp-servers`)
      .set("Cookie", COOKIE);
    expect(other.status).toBe(200);
    expect(other.body.servers).toEqual([]);

    const fetched = await request(app)
      .get(`/api/projects/${PROJECT}/mcp-servers/${serverId}`)
      .set("Cookie", COOKIE);
    expect(fetched.status).toBe(200);
    expect(fetched.body.server.id).toBe(serverId);

    const patched = await request(app)
      .patch(`/api/projects/${PROJECT}/mcp-servers/${serverId}`)
      .set("Cookie", COOKIE)
      .send({ name: "renamed", enabled: false });
    expect(patched.status).toBe(200);
    expect(patched.body.server).toMatchObject({
      name: "renamed",
      enabled: false,
    });

    const missing = await request(app)
      .get(`/api/projects/${PROJECT}/mcp-servers/${randomUUID()}`)
      .set("Cookie", COOKIE);
    expect(missing.status).toBe(404);

    const deleted = await request(app)
      .delete(`/api/projects/${PROJECT}/mcp-servers/${serverId}`)
      .set("Cookie", COOKIE);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });

    const after = await request(app)
      .get(`/api/projects/${PROJECT}/mcp-servers`)
      .set("Cookie", COOKIE);
    expect(after.body.servers).toEqual([]);
  });

  it("sync connects, discovers tools, and registers them into the registry", async () => {
    const { app, registry } = setup({
      discoverTools: async () => [
        {
          name: "search",
          description: "search helper",
          inputSchema: { type: "object" },
        },
        { name: "fetch", inputSchema: { type: "object" } },
      ],
    });

    const created = await request(app)
      .post(`/api/projects/${PROJECT}/mcp-servers`)
      .set("Cookie", COOKIE)
      .send(stdioBody("syncable"));
    const serverId = created.body.server.id as string;
    expect(registry.list().filter((t) => t.id.startsWith("mcp."))).toEqual([]);

    const synced = await request(app)
      .post(`/api/projects/${PROJECT}/mcp-servers/${serverId}/sync`)
      .set("Cookie", COOKIE);
    expect(synced.status).toBe(200);
    expect(synced.body.server.id).toBe(serverId);
    expect(synced.body.tools).toHaveLength(2);

    const registered = registry.list().filter((t) => t.id.startsWith("mcp."));
    expect(registered).toHaveLength(2);
    expect(registered.map((t) => t.id).sort()).toEqual(
      synced.body.tools.map((t: { id: string }) => t.id).sort(),
    );
  });

  it("deleting a server unregisters its tools", async () => {
    const { app, registry } = setup();
    const created = await request(app)
      .post(`/api/projects/${PROJECT}/mcp-servers`)
      .set("Cookie", COOKIE)
      .send(stdioBody("ephemeral"));
    const serverId = created.body.server.id as string;

    const synced = await request(app)
      .post(`/api/projects/${PROJECT}/mcp-servers/${serverId}/sync`)
      .set("Cookie", COOKIE);
    expect(synced.status).toBe(200);
    expect(registry.list().filter((t) => t.id.startsWith("mcp."))).toHaveLength(
      1,
    );

    const deleted = await request(app)
      .delete(`/api/projects/${PROJECT}/mcp-servers/${serverId}`)
      .set("Cookie", COOKIE);
    expect(deleted.status).toBe(200);
    expect(registry.list().filter((t) => t.id.startsWith("mcp."))).toEqual([]);
  });

  it("returns 502 when sync discovery fails", async () => {
    const { app } = setup({
      discoverTools: async () => {
        throw new Error("connection refused");
      },
    });
    const created = await request(app)
      .post(`/api/projects/${PROJECT}/mcp-servers`)
      .set("Cookie", COOKIE)
      .send(stdioBody("broken"));
    const serverId = created.body.server.id as string;
    const synced = await request(app)
      .post(`/api/projects/${PROJECT}/mcp-servers/${serverId}/sync`)
      .set("Cookie", COOKIE);
    expect(synced.status).toBe(502);
    expect(synced.body.error.code).toBe("SYNC_FAILED");
  });

  it("rejects invalid transport and bad secretRef with 400", async () => {
    const { app } = setup();

    const badTransport = await request(app)
      .post(`/api/projects/${PROJECT}/mcp-servers`)
      .set("Cookie", COOKIE)
      .send({
        name: "bad",
        transportConfig: { transport: "websocket", url: "https://x.example" },
      });
    expect(badTransport.status).toBe(400);
    expect(badTransport.body.error.code).toBe("BAD_REQUEST");

    const badSecret = await request(app)
      .post(`/api/projects/${PROJECT}/mcp-servers`)
      .set("Cookie", COOKIE)
      .send({
        name: "bad-secret",
        transportConfig: { transport: "stdio", command: "npx" },
        secretRefs: ["not-a-secret-ref"],
      });
    expect(badSecret.status).toBe(400);

    const badSecretScope = await request(app)
      .post(`/api/projects/${PROJECT}/mcp-servers`)
      .set("Cookie", COOKIE)
      .send({
        name: "bad-scope",
        transportConfig: { transport: "stdio", command: "npx" },
        secretRefs: ["secret://unknown/name"],
      });
    expect(badSecretScope.status).toBe(400);

    // Update path also validates.
    const created = await request(app)
      .post(`/api/projects/${PROJECT}/mcp-servers`)
      .set("Cookie", COOKIE)
      .send(stdioBody("valid"));
    const serverId = created.body.server.id as string;
    const badUpdate = await request(app)
      .patch(`/api/projects/${PROJECT}/mcp-servers/${serverId}`)
      .set("Cookie", COOKIE)
      .send({ transportConfig: { transport: "websocket" } });
    expect(badUpdate.status).toBe(400);

    const emptyUpdate = await request(app)
      .patch(`/api/projects/${PROJECT}/mcp-servers/${serverId}`)
      .set("Cookie", COOKIE)
      .send({});
    expect(emptyUpdate.status).toBe(400);
  });
});
