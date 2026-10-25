import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createApp } from "../../src/app";
import type { Config } from "../../src/config";
import type { Deps } from "../../src/context";
import type { Database } from "../../src/db/client";
import * as schema from "../../src/db/schema";
import { createLogger } from "../../src/lib/log";
import { createMetrics } from "../../src/lib/metrics";
import { createSecrets } from "../../src/lib/secrets";
import { issueApiKey } from "../../src/services/api-keys";
import { createResource, createService } from "../../src/services/catalog";
import { forgetDemo } from "../../src/services/demo";

export const TEST_SECRET = "test-app-secret-that-is-long-enough-0123456789";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    env: "test",
    port: 3000,
    publicUrl: "http://localhost:3000",
    databaseUrl: "postgres://unused",
    appSecret: TEST_SECRET,
    metricsToken: "metrics-token-0123456789",
    cronSecret: "cron-secret-0123456789",
    logLevel: "silent",
    demoEnabled: false,
    trustProxy: true,
    dbMaxConnections: 5,
    onVercel: false,
    version: "test",
    ...overrides,
  };
}

export interface Harness {
  app: ReturnType<typeof createApp>;
  deps: Deps;
  db: Database;
  clock: { set(iso: string): void; advance(minutes: number): void };
  /** Calls made to the outside world (webhook deliveries). */
  outbound: { url: string; init: RequestInit }[];
  /** What the fake outside world answers. */
  respondWith(status: number): void;
  /** Waits until every background task (webhook dispatch) has settled. */
  settle(): Promise<void>;
  request(path: string, init?: RequestInit & { key?: string; json?: unknown }): Promise<Response>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** A real Postgres (PGlite, in-process WASM) with the real migrations, and the real app on top. */
export async function createHarness(overrides: Partial<Config> = {}): Promise<Harness> {
  const pg = new PGlite({ extensions: { btree_gist } });
  const pglite = drizzle({ client: pg, schema });
  await migrate(pglite, { migrationsFolder: "drizzle" });
  const db = pglite as unknown as Database;

  let now = Temporal.Instant.from("2026-10-26T09:00:00Z");
  const outbound: Harness["outbound"] = [];
  let status = 204;
  const pending: Promise<unknown>[] = [];

  const deps: Deps = {
    config: testConfig(overrides),
    db,
    secrets: await createSecrets(TEST_SECRET),
    logger: createLogger({ level: "silent" }),
    metrics: createMetrics(),
    clock: { now: () => now },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      outbound.push({ url: String(input), init: init ?? {} });
      return new Response(null, { status });
    }) as typeof fetch,
    background: (task) => {
      pending.push(Promise.resolve(task));
    },
  };
  const app = createApp(deps);

  return {
    app,
    deps,
    db,
    clock: {
      set: (iso) => {
        now = Temporal.Instant.from(iso);
      },
      advance: (minutes) => {
        now = now.add({ minutes });
      },
    },
    outbound,
    respondWith: (next) => {
      status = next;
    },
    async settle() {
      while (pending.length > 0) await Promise.allSettled(pending.splice(0));
    },
    request(path, init = {}) {
      const headers = new Headers(init.headers);
      if (init.key) headers.set("authorization", `Bearer ${init.key}`);
      let body = init.body;
      if (init.json !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(init.json);
      }
      return Promise.resolve(app.request(path, { ...init, headers, body }));
    },
    async reset() {
      await db.execute(sql`truncate organizations, rate_limits, demo_inbox cascade`);
      outbound.length = 0;
      status = 204;
      now = Temporal.Instant.from("2026-10-26T09:00:00Z");
      forgetDemo();
    },
    close: () => pg.close(),
  };
}

export interface Club {
  organizationId: string;
  secretKey: string;
  publishableKey: string;
  courts: string[];
  matchServiceId: string;
}

/**
 * A padel club in Madrid: two courts open 08:00–23:00 every day, a 90-minute match with
 * 10 minutes of cleanup after, on a 30-minute grid, bookable from 30 minutes to 14 days ahead.
 */
export async function seedClub(harness: Pick<Harness, "db">, name = "Club"): Promise<Club> {
  const organizationId = Bun.randomUUIDv7();
  await harness.db.insert(schema.organizations).values({
    id: organizationId,
    name,
    slug: `${name.toLowerCase()}-${organizationId.slice(-6)}`,
    timezone: "Europe/Madrid",
  });
  const hours = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, opensAt: "08:00", closesAt: "23:00" }));
  const courts = [];
  for (const court of ["Court 1", "Court 2"]) {
    courts.push(
      (
        await createResource(harness.db, organizationId, {
          name: court,
          timezone: "Europe/Madrid",
          openingHours: hours,
        })
      ).id,
    );
  }
  const match = await createService(harness.db, organizationId, {
    name: "Match · 90 min",
    durationMinutes: 90,
    bufferAfterMinutes: 10,
    slotIntervalMinutes: 30,
    minNoticeMinutes: 30,
    maxAdvanceDays: 14,
    resourceIds: courts,
  });
  const secret = await issueApiKey(harness.db, { organizationId, name: "server", kind: "secret" });
  const publishable = await issueApiKey(harness.db, { organizationId, name: "widget", kind: "publishable" });
  return { organizationId, secretKey: secret.key, publishableKey: publishable.key, courts, matchServiceId: match.id };
}

export function booking(club: Club, startsAt: string, overrides: Record<string, unknown> = {}) {
  return {
    serviceId: club.matchServiceId,
    resourceId: club.courts[0],
    startsAt,
    customer: { name: "Lucía Fernández", email: "lucia@example.com" },
    ...overrides,
  };
}

export async function body<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
