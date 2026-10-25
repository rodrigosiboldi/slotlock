import { and, asc, eq, gt, inArray, lt } from "drizzle-orm";
import type { Executor } from "../db/client";
import { bookings, openingHours, resources, serviceResources, services, timeOff } from "../db/schema";
import { computeSlots, type Interval, MAX_RANGE_DAYS, type OpeningHours, type Schedule } from "../domain/availability";
import { problems } from "../lib/problem";
import { fromDbTime } from "./catalog";

export interface AvailableSlot {
  resourceId: string;
  timezone: string;
  start: Temporal.Instant;
  end: Temporal.Instant;
}

export interface ServiceRow {
  id: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  slotIntervalMinutes: number;
  minNoticeMinutes: number;
  maxAdvanceDays: number;
}

/**
 * Open slots for a service between two local dates, across every resource that offers it
 * (or one of them). Each resource's dates are read in its own time zone.
 */
export async function findAvailability(
  db: Executor,
  organizationId: string,
  query: { serviceId: string; resourceId?: string | undefined; from: Temporal.PlainDate; to: Temporal.PlainDate },
  now: Temporal.Instant,
): Promise<AvailableSlot[]> {
  const days = query.from.until(query.to, { largestUnit: "days" }).days + 1;
  if (days < 1) throw problems.unprocessable("invalid-range", "Invalid date range", "`to` must not be before `from`.");
  if (days > MAX_RANGE_DAYS) {
    throw problems.unprocessable(
      "invalid-range",
      "Date range too long",
      `Ask for at most ${MAX_RANGE_DAYS} days at a time.`,
    );
  }

  const service = await loadActiveService(db, organizationId, query.serviceId);
  const offered = await db
    .select({ id: resources.id, timezone: resources.timezone })
    .from(serviceResources)
    .innerJoin(resources, eq(resources.id, serviceResources.resourceId))
    .where(
      and(
        eq(serviceResources.serviceId, service.id),
        eq(resources.active, true),
        query.resourceId ? eq(resources.id, query.resourceId) : undefined,
      ),
    )
    .orderBy(asc(resources.id));
  if (query.resourceId && offered.length === 0) {
    throw problems.unprocessable(
      "service-not-offered",
      "Service not offered",
      "That resource does not offer this service.",
    );
  }
  if (offered.length === 0) return [];

  // One generous instant range covers every zone: a day of margin on each side.
  const rangeStart = new Date(
    Temporal.Instant.from(`${query.from.toString()}T00:00:00Z`).subtract({ hours: 48 }).epochMilliseconds,
  );
  const rangeEnd = new Date(
    Temporal.Instant.from(`${query.to.toString()}T00:00:00Z`).add({ hours: 72 }).epochMilliseconds,
  );
  const resourceIds = offered.map((resource) => resource.id);
  const [hours, busyBookings, offTime] = await Promise.all([
    db.select().from(openingHours).where(inArray(openingHours.resourceId, resourceIds)),
    db
      .select({ resourceId: bookings.resourceId, from: bookings.blockedFrom, until: bookings.blockedUntil })
      .from(bookings)
      .where(
        and(
          inArray(bookings.resourceId, resourceIds),
          eq(bookings.status, "confirmed"),
          lt(bookings.blockedFrom, rangeEnd),
          gt(bookings.blockedUntil, rangeStart),
        ),
      ),
    db
      .select({ resourceId: timeOff.resourceId, from: timeOff.startsAt, until: timeOff.endsAt })
      .from(timeOff)
      .where(
        and(inArray(timeOff.resourceId, resourceIds), lt(timeOff.startsAt, rangeEnd), gt(timeOff.endsAt, rangeStart)),
      ),
  ]);

  const slots: AvailableSlot[] = [];
  for (const resource of offered) {
    const schedule: Schedule = {
      timezone: resource.timezone,
      openingHours: hours.filter((row) => row.resourceId === resource.id).map(toOpeningHours),
      service,
    };
    const busy = [...busyBookings, ...offTime]
      .filter((row) => row.resourceId === resource.id)
      .map((row) => toInterval(row.from, row.until));
    for (const slot of computeSlots(schedule, busy, query, now)) {
      slots.push({ resourceId: resource.id, timezone: resource.timezone, ...slot });
    }
  }
  return slots.sort((a, b) => Temporal.Instant.compare(a.start, b.start) || a.resourceId.localeCompare(b.resourceId));
}

export async function loadActiveService(db: Executor, organizationId: string, serviceId: string): Promise<ServiceRow> {
  const [service] = await db
    .select({
      id: services.id,
      durationMinutes: services.durationMinutes,
      bufferBeforeMinutes: services.bufferBeforeMinutes,
      bufferAfterMinutes: services.bufferAfterMinutes,
      slotIntervalMinutes: services.slotIntervalMinutes,
      minNoticeMinutes: services.minNoticeMinutes,
      maxAdvanceDays: services.maxAdvanceDays,
      active: services.active,
    })
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.organizationId, organizationId)))
    .limit(1);
  if (!service) throw problems.notFound("Service");
  if (!service.active)
    throw problems.unprocessable("service-inactive", "Service inactive", "This service is not bookable.");
  return service;
}

export function toOpeningHours(row: typeof openingHours.$inferSelect): OpeningHours {
  return { weekday: row.weekday, opensAt: fromDbTime(row.opensAt), closesAt: fromDbTime(row.closesAt) };
}

export function toInterval(from: Date, until: Date): Interval {
  return {
    start: Temporal.Instant.fromEpochMilliseconds(from.getTime()),
    end: Temporal.Instant.fromEpochMilliseconds(until.getTime()),
  };
}
