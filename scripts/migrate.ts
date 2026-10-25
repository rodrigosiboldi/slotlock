/**
 * Applies the SQL migrations in ./drizzle. Uses DIRECT_DATABASE_URL when set: migrations
 * belong on a direct connection, not on a transaction-mode pooler.
 *
 *   bun run db:migrate
 */
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";

const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL (or DIRECT_DATABASE_URL).");
  process.exit(1);
}

const client = new SQL({ url, max: 1 });
const started = performance.now();
await migrate(drizzle({ client }), { migrationsFolder: "drizzle" });
const [check] = await client`select exists (select 1 from pg_constraint where conname = 'bookings_no_overlap') as ok`;
console.log(
  `Migrations applied in ${Math.round(performance.now() - started)} ms; no-overlap constraint present: ${check?.ok}`,
);
await client.close();
