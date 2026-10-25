import { z } from "zod";

const booleanish = z.enum(["true", "false", "1", "0"]).transform((value) => value === "true" || value === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Public origin of the API, used in links and webhook URLs. Derived on Vercel when unset. */
  PUBLIC_URL: z.url().optional(),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL"),
  /** Master secret; encryption and signing keys are derived from it with HKDF. */
  APP_SECRET: z.string().min(32, "must be at least 32 characters"),
  /** Bearer token for GET /metrics. Without it the endpoint is disabled. */
  METRICS_TOKEN: z.string().min(16).optional(),
  /** Set by Vercel for cron invocations. */
  CRON_SECRET: z.string().min(16).optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  /** Serve the public demo (landing page, race, webhook inbox). */
  DEMO_ENABLED: booleanish.default(true),
  /** Trust X-Forwarded-For from the platform's proxy (true on Vercel). */
  TRUST_PROXY: booleanish.optional(),
  /** Per process. Requests share connections; only transactions hold one of their own. */
  DB_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(5),
  VERCEL: z.string().optional(),
  VERCEL_PROJECT_PRODUCTION_URL: z.string().optional(),
  VERCEL_URL: z.string().optional(),
  VERCEL_GIT_COMMIT_SHA: z.string().optional(),
});

export interface Config {
  env: "development" | "test" | "production";
  port: number;
  publicUrl: string;
  databaseUrl: string;
  appSecret: string;
  metricsToken: string | undefined;
  cronSecret: string | undefined;
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
  demoEnabled: boolean;
  trustProxy: boolean;
  dbMaxConnections: number;
  onVercel: boolean;
  version: string;
}

/** Reads and validates the environment once at startup; fails fast with every problem listed. */
export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid environment:\n${problems.join("\n")}`);
  }
  const env = parsed.data;
  const onVercel = env.VERCEL === "1";
  const vercelHost = env.VERCEL_PROJECT_PRODUCTION_URL ?? env.VERCEL_URL;
  const publicUrl = env.PUBLIC_URL ?? (vercelHost ? `https://${vercelHost}` : `http://localhost:${env.PORT}`);
  return {
    env: env.NODE_ENV,
    port: env.PORT,
    publicUrl: publicUrl.replace(/\/+$/, ""),
    databaseUrl: env.DATABASE_URL,
    appSecret: env.APP_SECRET,
    metricsToken: env.METRICS_TOKEN,
    cronSecret: env.CRON_SECRET,
    logLevel: env.LOG_LEVEL,
    demoEnabled: env.DEMO_ENABLED,
    trustProxy: env.TRUST_PROXY ?? onVercel,
    dbMaxConnections: env.DB_MAX_CONNECTIONS,
    onVercel,
    version: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "dev",
  };
}
