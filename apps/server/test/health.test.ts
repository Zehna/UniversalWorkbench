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

  it("returns a request-correlated 400 envelope for malformed JSON", async () => {
    const app = createApp({ databaseReady: async () => true });
    const response = await request(app)
      .post("/health/live")
      .set("content-type", "application/json")
      .send('{"broken":');

    expect(response.status).toBe(400);
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(response.body).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "Invalid request body",
        requestId: response.headers["x-request-id"],
      },
    });
  });

  it("returns a JSON 404 envelope with a request ID for unknown routes", async () => {
    const app = createApp({ databaseReady: async () => true });
    const response = await request(app).get("/does-not-exist");

    expect(response.status).toBe(404);
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(response.body).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Route not found",
        requestId: response.headers["x-request-id"],
      },
    });
  });
});
