import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

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

  it("accepts worker mode once the execution worker runtime exists", () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      APP_MODE: "worker",
    });
    expect(config.appMode).toBe("worker");
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
