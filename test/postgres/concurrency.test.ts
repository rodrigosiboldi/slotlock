/**
 * The no-double-booking guarantee against a real Postgres server with a real connection pool,
 * so transactions genuinely run in parallel (PGlite, used by the other tests, is single-session).
 * Runs only when TEST_DATABASE_URL is set; CI provides a Postgres 17 service for it.
 *
 *   TEST_DATABASE_URL=postgres://… bun test test/postgres
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { createApp } from "../../src/app";
import type { Deps } from "../../src/context";
import { connectDatabase, type DatabaseHandle } from "../../src/db/client";
import { uuidv7 } from "../../src/lib/crypto";
import { createLogger } from "../../src/lib/log";
import { createMetrics } from "../../src/lib/metrics";
import { createSecrets } from "../../src/lib/secrets";
import { eventsAfter, latestCursor } from "../../src/services/events";
import { booking, type Club, seedClub, TEST_SECRET, testConfig } from "../support/harness";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("on a real Postgres server", () => {
  let handle: DatabaseHandle;
  let app: ReturnType<typeof createApp>;
  let club: Club;

  beforeAll(async () => {
    const migrator = new SQL({ url: url as string, max: 1 });
    await migrate(drizzle({ client: migrator }), { migrationsFolder: "drizzle" });
    await migrator.close();

    handle = connectDatabase(url as string, { maxConnections: 20 });
    await handle.db.execute(sql`truncate organizations, rate_limits, demo_inbox cascade`);
    const deps: Deps = {
      config: testConfig(),
      db: handle.db,
      secrets: await createSecrets(TEST_SECRET),
      logger: createLogger({ level: "silent" }),
      metrics: createMetrics(),
      clock: { now: () => Temporal.Instant.from("2026-10-26T09:00:00Z") },
      fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
      background: () => {},
    };
    app = createApp(deps);
    club = await seedClub({ db: handle.db });
  });

  afterAll(async () => {
    await handle?.db.execute(sql`truncate organizations, rate_limits, demo_inbox cascade`);
    await handle?.close();
  });

  test("200 requests over 20 connections for one slot: exactly one booking", async () => {
    const attempts = Array.from({ length: 200 }, (_, i) =>
      app.request("/v1/bookings", {
        method: "POST",
        headers: { authorization: `Bearer ${club.secretKey}`, "content-type": "application/json" },
        body: JSON.stringify(
          booking(club, "2026-10-29T19:30:00+01:00", { customer: { name: `P${i}`, email: `p${i}@example.com` } }),
        ),
      }),
    );
    const statuses = (await Promise.all(attempts)).map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(199);

    const rows = await handle.db.execute<{ count: string }>(
      sql`select count(*)::text as count from bookings where status = 'confirmed'`,
    );
    const count = Array.isArray(rows) ? rows[0]?.count : (rows as { rows: { count: string }[] }).rows[0]?.count;
    expect(count).toBe("1");
  }, 60_000);

  test("the event feed never skips an event whose transaction commits late", async () => {
    const start = await latestCursor(handle.db, club.organizationId);
    const raw = new SQL({ url: url as string, max: 2 });
    const insert = (db: SQL, n: number) =>
      db`insert into events (id, organization_id, type, data)
         values (${uuidv7()}, ${club.organizationId}, 'booking.created', ${JSON.stringify({ n })}::jsonb)`;
    // T1 writes first but commits last; T2 writes and commits in between.
    const t1 = await raw.reserve();
    await t1`begin`;
    await insert(t1, 1);
    await insert(raw, 2);
    const read = async () =>
      (await eventsAfter(handle.db, club.organizationId, start, { limit: 10 })).map((event) => event.data.n);
    // A naive "id > cursor" reader would return [2] here and then never see 1.
    expect(await read()).toEqual([]);
    await t1`commit`;
    t1.release();
    expect(await read()).toEqual([1, 2]);
    await raw.close();
  }, 60_000);
});
