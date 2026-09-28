import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    environment: "node",
    // Integration files drop/recreate the same public and drizzle schemas.
    // Run files serially to prevent independent workers from racing on DDL.
    fileParallelism: false,
  },
});
