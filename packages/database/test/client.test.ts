import { describe, expect, it } from "vitest";
import { closeDatabasePool, createDatabasePool } from "../src/index.js";

describe("database pool", () => {
  it("uses a bounded connection timeout", async () => {
    const pool = createDatabasePool("postgresql://u:p@localhost:5432/db");
    try {
      expect(pool.options.connectionTimeoutMillis).toBeGreaterThan(0);
      expect(pool.options.connectionTimeoutMillis).toBeLessThanOrEqual(5000);
    } finally {
      await closeDatabasePool(pool);
    }
  });

  it("registers an idle-client error listener", async () => {
    const pool = createDatabasePool("postgresql://u:p@localhost:5432/db");
    try {
      expect(pool.listenerCount("error")).toBeGreaterThan(0);
    } finally {
      await closeDatabasePool(pool);
    }
  });
});
