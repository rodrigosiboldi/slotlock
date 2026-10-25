import { and, asc, eq, gt, sql } from "drizzle-orm";
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

/** Events in creation order. UUIDv7 ids sort by time, so the id alone is a stable cursor. */
export async function listEvents(
  db: Executor,
  organizationId: string,
  page: { limit: number; after?: string | undefined; type?: string | undefined },
): Promise<DomainEvent[]> {
  return db
    .select({ id: events.id, type: events.type, data: events.data, createdAt: events.createdAt })
    .from(events)
    .where(
      and(
        eq(events.organizationId, organizationId),
        page.after ? gt(events.id, page.after) : undefined,
        page.type ? eq(events.type, page.type) : undefined,
      ),
    )
    .orderBy(asc(events.id))
    .limit(page.limit);
}
