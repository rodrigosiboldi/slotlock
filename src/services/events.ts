import { and, asc, desc, eq, like, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { events, webhookDeliveries, webhookEndpoints } from "../db/schema";
import { uuidv7 } from "../lib/crypto";

export const EVENT_TYPES = ["booking.created", "booking.cancelled", "booking.rescheduled"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface DomainEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Transactional outbox: the event and one pending delivery per subscribed endpoint are written in
 * the caller's transaction, so a committed booking always has its webhooks queued and a rolled-back
 * one never does. A dispatcher sends them afterwards (services/webhooks.ts).
 */
export async function recordEvent(
  tx: Executor,
  organizationId: string,
  type: EventType,
  data: Record<string, unknown>,
  now: Date,
): Promise<{ eventId: string; deliveries: number }> {
  const eventId = uuidv7();
  // Timestamps come from the application clock, the same one the dispatcher compares against:
  // mixing it with the database's now() would make deliveries wait out any clock skew.
  await tx.insert(events).values({ id: eventId, organizationId, type, data, createdAt: now });
  const endpoints = await tx
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.organizationId, organizationId),
        eq(webhookEndpoints.active, true),
        sql`(${webhookEndpoints.events} @> array[${type}]::text[] or ${webhookEndpoints.events} @> array['*']::text[])`,
      ),
    );
  if (endpoints.length > 0) {
    await tx.insert(webhookDeliveries).values(
      endpoints.map((endpoint) => ({
        id: uuidv7(),
        endpointId: endpoint.id,
        eventId,
        nextAttemptAt: now,
        createdAt: now,
      })),
    );
  }
  return { eventId, deliveries: endpoints.length };
}

/** Position in the event feed: the writing transaction, then the event id within it. */
export interface FeedCursor {
  tx: string;
  id: string;
}

export interface FeedEvent extends DomainEvent {
  cursor: FeedCursor;
}

/**
 * Only events whose transaction is older than every transaction still running are visible.
 * Ids are minted before commit, so without this a reader could see a later transaction's event,
 * move its cursor past it, and never see the earlier one that commits a moment after.
 */
const settled = sql`${events.txId} < pg_snapshot_xmin(pg_current_snapshot())`;

/** Events after a cursor, in commit-safe order. No event is ever skipped or returned twice. */
export async function eventsAfter(
  db: Executor,
  organizationId: string,
  after: FeedCursor | null,
  options: { limit: number; type?: string | undefined; typePrefix?: string | undefined },
): Promise<FeedEvent[]> {
  const rows = await db
    .select({
      id: events.id,
      type: events.type,
      data: events.data,
      createdAt: events.createdAt,
      tx: sql<string>`${events.txId}::text`,
    })
    .from(events)
    .where(
      and(
        eq(events.organizationId, organizationId),
        settled,
        after ? sql`(${events.txId}, ${events.id}) > (${after.tx}::xid8, ${after.id}::uuid)` : undefined,
        options.type ? eq(events.type, options.type) : undefined,
        options.typePrefix ? like(events.type, `${options.typePrefix}%`) : undefined,
      ),
    )
    .orderBy(asc(events.txId), asc(events.id))
    .limit(options.limit);
  return rows.map(({ tx, ...event }) => ({ ...event, cursor: { tx, id: event.id } }));
}

/** Where a new reader should start to see only what happens from now on. */
export async function latestCursor(db: Executor, organizationId: string): Promise<FeedCursor | null> {
  const [row] = await db
    .select({ id: events.id, tx: sql<string>`${events.txId}::text` })
    .from(events)
    .where(and(eq(events.organizationId, organizationId), settled))
    .orderBy(desc(events.txId), desc(events.id))
    .limit(1);
  return row ? { tx: row.tx, id: row.id } : null;
}

export function encodeFeedCursor(cursor: FeedCursor): string {
  return `${cursor.tx}.${cursor.id}`;
}

export function decodeFeedCursor(value: string | undefined | null): FeedCursor | null {
  const match = value
    ? /^(\d{1,20})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(value)
    : null;
  return match?.[1] && match[2] ? { tx: match[1], id: match[2] } : null;
}
