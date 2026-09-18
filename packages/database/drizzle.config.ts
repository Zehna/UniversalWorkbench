import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run Drizzle commands");
}

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const relativeToCwd = (path: string) =>
  relative(process.cwd(), resolve(packageDirectory, path)).replaceAll(
    "\\",
    "/",
  );

export default defineConfig({
  dialect: "postgresql",
  schema: relativeToCwd("src/schema.ts"),
  out: relativeToCwd("drizzle"),
  dbCredentials: {
    url: databaseUrl,
  },
});
