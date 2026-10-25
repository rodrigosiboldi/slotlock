import { problems } from "../lib/problem";
import type { AvailableSlot } from "../services/availability";
import { localIso } from "../services/bookings";
import type { Resource, Service, TimeOff } from "../services/catalog";
import type { DomainEvent } from "../services/events";
import type { WebhookDelivery, WebhookEndpoint } from "../services/webhooks";

export { serializeBooking } from "../services/bookings";

export function serializeResource(resource: Resource) {
  return {
    id: resource.id,
    object: "resource" as const,
    name: resource.name,
    timezone: resource.timezone,
    active: resource.active,
    metadata: resource.metadata,
    openingHours: resource.openingHours,
    createdAt: resource.createdAt.toISOString(),
    updatedAt: resource.updatedAt.toISOString(),
  };
}

export function serializeService(service: Service) {
  return {
    id: service.id,
    object: "service" as const,
    name: service.name,
    durationMinutes: service.durationMinutes,
    bufferBeforeMinutes: service.bufferBeforeMinutes,
    bufferAfterMinutes: service.bufferAfterMinutes,
    slotIntervalMinutes: service.slotIntervalMinutes,
    minNoticeMinutes: service.minNoticeMinutes,
    maxAdvanceDays: service.maxAdvanceDays,
    price: service.price,
    active: service.active,
    resourceIds: service.resourceIds,
    createdAt: service.createdAt.toISOString(),
    updatedAt: service.updatedAt.toISOString(),
  };
}

export function serializeTimeOff(entry: TimeOff, timezone: string) {
  return {
    id: entry.id,
    object: "time_off" as const,
    resourceId: entry.resourceId,
    startsAt: localIso(entry.startsAt, timezone),
    endsAt: localIso(entry.endsAt, timezone),
    reason: entry.reason,
    createdAt: entry.createdAt.toISOString(),
  };
}

export function serializeSlot(slot: AvailableSlot) {
  const zoned = (instant: Temporal.Instant) =>
    instant.toZonedDateTimeISO(slot.timezone).toString({ timeZoneName: "never", smallestUnit: "second" });
  return { resourceId: slot.resourceId, start: zoned(slot.start), end: zoned(slot.end) };
}

export function serializeEndpoint(endpoint: WebhookEndpoint) {
  return {
    id: endpoint.id,
    object: "webhook_endpoint" as const,
    url: endpoint.url,
    description: endpoint.description,
    events: endpoint.events as ("booking.created" | "booking.cancelled" | "booking.rescheduled" | "*")[],
    active: endpoint.active,
    createdAt: endpoint.createdAt.toISOString(),
  };
}

export function serializeDelivery(delivery: WebhookDelivery) {
  return {
    id: delivery.id,
    object: "webhook_delivery" as const,
    eventId: delivery.eventId,
    eventType: delivery.eventType,
    status: delivery.status,
    attempts: delivery.attempts,
    nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
    lastAttemptAt: delivery.lastAttemptAt?.toISOString() ?? null,
    lastResponseStatus: delivery.lastResponseStatus,
    lastError: delivery.lastError,
    lastDurationMs: delivery.lastDurationMs,
    createdAt: delivery.createdAt.toISOString(),
  };
}

export function serializeEvent(event: DomainEvent) {
  return {
    id: event.id,
    object: "event" as const,
    type: event.type,
    data: event.data,
    createdAt: event.createdAt.toISOString(),
  };
}

/** Opaque pagination cursors: base64url JSON, so their shape can change without breaking clients. */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor<T>(cursor: string | undefined, guard: (value: unknown) => value is T): T | undefined {
  if (!cursor) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    value = undefined;
  }
  if (!guard(value)) throw problems.validation([{ path: "cursor", message: "Invalid or expired cursor." }]);
  return value;
}
