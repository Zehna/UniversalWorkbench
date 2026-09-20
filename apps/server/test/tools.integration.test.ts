import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AuthService } from "@uw/auth";
import { ToolRegistry, type ToolRunner } from "@uw/tools";
import { createApp } from "../src/app.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-09-20T00:00:00.000Z";

const runner: ToolRunner = {
  async run() {
    throw new Error("not used");
  },
};

function deps(authenticated = true) {
  const authService = {
    isInitialized: vi.fn().mockResolvedValue(true),
    setupOwner: vi.fn(),
    login: vi.fn(),
    resolveSession: vi.fn().mockResolvedValue(
      authenticated
        ? { id: OWNER_ID, username: "owner", createdAt: NOW }
        : null,
    ),
    logout: vi.fn(),
  } satisfies AuthService;

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(
    {
      id: "builtin.fixture.json",
      version: "1",
      displayName: "JSON Fixture",
      description: "Test fixture",
      executionMode: "worker",
      accepts: [{ name: "input", types: ["json"], required: true }],
      produces: [{ name: "output", types: ["text"] }],
      configSchema: {},
      requiredCapabilities: [],
      defaults: { timeoutMs: 1000, maxAttempts: 1 },
    },
    runner,
  );

  return {
    databaseReady: async () => true,
    authService,
    sessionCookie: {
      name: "uw_session",
      secure: false,
      maxAgeSeconds: 604800,
    },
    toolRegistry,
  };
}

describe("Phase 3 tools API", () => {
  it("requires authentication", async () => {
    const response = await request(createApp(deps(false))).get("/tools");
    expect(response.status).toBe(401);
  });

  it("lists exact registered tool versions", async () => {
    const response = await request(createApp(deps()))
      .get("/tools")
      .set("Cookie", "uw_session=raw-token");

    expect(response.status).toBe(200);
    expect(response.body.tools).toEqual([
      expect.objectContaining({
        id: "builtin.fixture.json",
        version: "1",
      }),
    ]);
  });

  it("returns compatible targets by typed context", async () => {
    const response = await request(createApp(deps()))
      .post("/tools/compatibility")
      .set("Cookie", "uw_session=raw-token")
      .send({ type: "json" });

    expect(response.status).toBe(200);
    expect(response.body.targets).toEqual([
      expect.objectContaining({
        definition: expect.objectContaining({
          id: "builtin.fixture.json",
          version: "1",
        }),
        inputPort: expect.objectContaining({ name: "input" }),
      }),
    ]);
  });
});
