import { z } from "zod";

const ConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_MODE: z.enum(["all", "api", "worker"]).default("all"),
});

export interface ServerConfig {
  databaseUrl: string;
  port: number;
  appMode: "all" | "api" | "worker";
}

export function loadConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ServerConfig {
  const parsed = ConfigSchema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.PORT,
    appMode: parsed.APP_MODE,
  };
}
