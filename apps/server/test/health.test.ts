import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";

describe("health routes", () => {
  it("returns liveness without consulting dependencies", async () => {
    const databaseReady = vi.fn().mockResolvedValue(false);
    const app = createApp({ databaseReady });
    const response = await request(app).get("/health/live");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(databaseReady).not.toHaveBeenCalled();
  });

  it("returns readiness when PostgreSQL is ready", async () => {
    const app = createApp({ databaseReady: async () => true });
    const response = await request(app).get("/health/ready");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ready",
      checks: { database: "ok" },
    });
  });

  it("returns 503 when PostgreSQL is not ready", async () => {
    const app = createApp({ databaseReady: async () => false });
    const response = await request(app).get("/health/ready");
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: "not_ready",
      checks: { database: "error" },
    });
  });
});
