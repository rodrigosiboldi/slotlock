import type { Config } from "./config";
import type { Database } from "./db/client";
import type { ApiKeyKind } from "./db/schema";
import type { Logger } from "./lib/log";
import type { Metrics } from "./lib/metrics";
import type { Secrets } from "./lib/secrets";

/** Everything the app needs from the outside world, injected so tests can swap any piece. */
export interface Deps {
  config: Config;
  db: Database;
  secrets: Secrets;
  logger: Logger;
  metrics: Metrics;
  clock: { now(): Temporal.Instant };
  /** Outbound HTTP for webhook deliveries. */
  fetch: typeof fetch;
  /**
   * Work that must outlive the response (webhook dispatch, bookkeeping): `waitUntil` on Vercel,
   * tracked promises on the standalone server so a graceful shutdown can wait for them.
   */
  background(task: Promise<unknown>): void;
}

export const SCOPES = [
  "catalog:read",
  "catalog:write",
  "availability:read",
  "bookings:create",
  "bookings:read",
  "bookings:write",
  "webhooks:manage",
] as const;
export type Scope = (typeof SCOPES)[number];

/** Publishable keys are embedded in public booking widgets: they can look and book, nothing else. */
export const PUBLISHABLE_SCOPES: readonly Scope[] = ["catalog:read", "availability:read", "bookings:create"];

export interface AuthContext {
  organizationId: string;
  timezone: string;
  keyId: string;
  kind: ApiKeyKind;
  scopes: ReadonlySet<Scope>;
}

export interface AppEnv {
  Variables: {
    requestId: string;
    log: Logger;
    auth: AuthContext;
    /** Set when a valid demo race ticket accompanies the request. */
    race?: { id: string; resourceId: string };
  };
}
