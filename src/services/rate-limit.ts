import { sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { rateLimits } from "../db/schema";

export interface RatePolicy {
  name: string;
  limit: number;
  windowSeconds: number;
}

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the current window ends. */
  resetSeconds: number;
}

export const POLICIES = {
  /** Back-office integrations: per secret key. */
  secretKey: { name: "secret-key", limit: 600, windowSeconds: 60 },
  /** Public widgets: per publishable key and client IP. */
  publishableKey: { name: "publishable-key", limit: 120, windowSeconds: 60 },
  /** Booking attempts from public widgets: per publishable key and client IP. */
  publicBookings: { name: "public-bookings", limit: 20, windowSeconds: 60 },
  /** A demo race: one ticket buys a bounded burst of attempts at a single slot. */
  race: { name: "race", limit: 250, windowSeconds: 120 },
  /** Starting demo races: per client IP. */
  raceStarts: { name: "race-starts", limit: 6, windowSeconds: 60 },
} satisfies Record<string, RatePolicy>;

/**
 * Sliding-window counter (the approximation Cloudflare and others use), kept in Postgres so every
 * instance of a serverless deployment shares it. One statement, no read-modify-write race:
 *
 *   estimate = previous window × (portion of it still inside the sliding window) + current window
 */
export async function hit(db: Executor, policy: RatePolicy, subject: string, nowMs: number): Promise<RateDecision> {
  const windowMs = policy.windowSeconds * 1000;
  const windowStart = Math.floor(nowMs / windowMs) * windowMs;
  const existing = sql.raw(`"${rateLimits.windowStartMs.name}"`);
  const [row] = await db
    .insert(rateLimits)
    .values({ key: `${policy.name}:${subject}`, windowStartMs: windowStart, count: 1, previousCount: 0 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        // Every expression sees the row as it was before this statement.
        previousCount: sql`case
          when ${rateLimits}.${existing} = ${windowStart} then ${rateLimits.previousCount}
          when ${rateLimits}.${existing} = ${windowStart - windowMs} then ${rateLimits.count}
          else 0 end`,
        count: sql`case when ${rateLimits}.${existing} = ${windowStart} then ${rateLimits.count} + 1 else 1 end`,
        windowStartMs: windowStart,
      },
    })
    .returning({ count: rateLimits.count, previousCount: rateLimits.previousCount });

  const count = row?.count ?? 1;
  const previous = row?.previousCount ?? 0;
  const elapsed = (nowMs - windowStart) / windowMs;
  const estimate = previous * (1 - elapsed) + count;
  return {
    allowed: estimate <= policy.limit,
    limit: policy.limit,
    remaining: Math.max(0, Math.floor(policy.limit - estimate)),
    resetSeconds: Math.max(1, Math.ceil((windowStart + windowMs - nowMs) / 1000)),
  };
}
