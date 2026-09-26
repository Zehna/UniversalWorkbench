import { describe, expect, it } from "vitest";
import { loadConfig, runtimeRoles } from "../src/config.js";

describe("server config", () => {
  it("accepts a valid Phase 0 configuration", () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      PORT: "3000",
      APP_MODE: "all",
    });
    expect(config.port).toBe(3000);
    expect(config.appMode).toBe("all");
    expect(config.trustedOrigins).toContain("http://localhost:8080");
  });

  it("parses trusted origins from a comma-separated setting", () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      TRUSTED_ORIGINS: "https://app.example, https://admin.example",
    });

    expect(config.trustedOrigins).toEqual([
      "https://app.example",
      "https://admin.example",
    ]);
  });

  it("accepts worker-only mode without an HTTP listener", () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      APP_MODE: "worker",
      WORKER_POLL_MS: "250",
      WORKER_LEASE_MS: "5000",
      WORKER_RETRY_MS: "10000",
    });
    expect(config.appMode).toBe("worker");
    expect(config.workerPollMs).toBe(250);
    expect(config.workerLeaseMs).toBe(5000);
    expect(config.workerRetryMs).toBe(10000);
    expect(runtimeRoles(config.appMode)).toEqual({ http: false, worker: true });
    expect(runtimeRoles("all")).toEqual({ http: true, worker: true });
    expect(runtimeRoles("api")).toEqual({ http: true, worker: false });
  });

  it("rejects invalid worker intervals", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgresql://u:p@localhost:5432/db",
        WORKER_LEASE_MS: "500",
      }),
    ).toThrow();
  });

  it("rejects an unsupported app mode", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgresql://u:p@localhost:5432/db",
        APP_MODE: "magic",
      }),
    ).toThrow();
  });
});
