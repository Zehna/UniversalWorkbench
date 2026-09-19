import { z } from "zod";

const ConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_MODE: z.enum(["all", "api"]).default("all"),
  SESSION_COOKIE_NAME: z.string().min(1).default("uw_session"),
  SESSION_COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604800),
  ARTIFACTS_DIR: z.string().min(1).default("./data/artifacts"),
  TRUSTED_ORIGINS: z
    .string()
    .min(1)
    .default(
      "http://localhost:8080,http://127.0.0.1:8080,http://localhost:5173,http://127.0.0.1:5173",
    )
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
});

export interface ServerConfig {
  databaseUrl: string;
  port: number;
  appMode: "all" | "api";
  sessionCookieName: string;
  sessionCookieSecure: boolean;
  sessionTtlSeconds: number;
  artifactsDir: string;
  trustedOrigins: string[];
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
    artifactsDir: parsed.ARTIFACTS_DIR,
    trustedOrigins: parsed.TRUSTED_ORIGINS,
  };
}
