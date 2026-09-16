import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run Drizzle commands");
}

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  dialect: "postgresql",
  schema: resolve(packageDirectory, "src/schema.ts"),
  out: resolve(packageDirectory, "drizzle"),
  dbCredentials: {
    url: databaseUrl,
  },
});
