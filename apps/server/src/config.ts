import { z } from "zod";

const BooleanStringSchema = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const ConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_MODE: z.enum(["all", "api"]).default("all"),
  SESSION_COOKIE_NAME: z.string().trim().min(1).max(64).default("uw_session"),
  SESSION_COOKIE_SECURE: BooleanStringSchema,
  SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(60 * 60 * 24 * 31)
    .default(60 * 60 * 24 * 7),
});

export interface ServerConfig {
  databaseUrl: string;
  port: number;
  appMode: "all" | "api";
  sessionCookieName: string;
  sessionCookieSecure: boolean;
  sessionTtlSeconds: number;
}

export function loadConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ServerConfig {
  const parsed = ConfigSchema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.PORT,
    appMode: parsed.APP_MODE,
    sessionCookieName: parsed.SESSION_COOKIE_NAME,
    sessionCookieSecure: parsed.SESSION_COOKIE_SECURE,
    sessionTtlSeconds: parsed.SESSION_TTL_SECONDS,
  };
}
