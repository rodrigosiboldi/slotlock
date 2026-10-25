import { and, asc, eq, gt, gte, lt, or } from "drizzle-orm";
import type { AuthContext, Deps } from "../context";
import { type Executor, SQLSTATE, sqlState } from "../db/client";
import { bookings, openingHours, resources, serviceResources, timeOff } from "../db/schema";
import { blockedInterval, checkStart, type StartProblem } from "../domain/availability";
import { uuidv7 } from "../lib/crypto";
import { problems } from "../lib/problem";
import { loadActiveService, type ServiceRow, toInterval, toOpeningHours } from "./availability";
import { recordEvent } from "./events";

export interface Booking {
  id: string;
  resourceId: string;
  serviceId: string;
  status: "confirmed" | "cancelled";
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  customer: { name: string; email: string; phone: string | null };
  notes: string | null;
  metadata: Record<string, string>;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewBooking {
  serviceId: string;
  /** Omit to take the first resource offering the service that is free at that time. */
  resourceId?: string | undefined;
  startsAt: Temporal.Instant;
  customer: { name: string; email: string; phone?: string | null | undefined };
  notes?: string | null | undefined;
  metadata?: Record<string, string> | undefined;
}

const START_PROBLEM_TEXT: Record<StartProblem, string> = {
  outside_opening_hours: "The slot is outside the resource's opening hours.",
  off_grid: "Customers can only book the start times availability offers.",
  too_soon: "The slot starts too soon; the service requires more notice.",
  too_far_ahead: "The slot is further ahead than the service allows.",
  time_off: "The resource is off at that time.",
};

/**
 * Books a slot. The application checks opening hours and customer rules; whether the slot is
 * still free is decided by Postgres alone (the bookings_no_overlap exclusion constraint), so two
 * requests racing for the same slot cannot both win, whatever instance or connection they hit.
 */
export async function createBooking(
  deps: Pick<Deps, "db" | "clock" | "metrics">,
  auth: AuthContext,
  input: NewBooking,
): Promise<Booking> {
  const service = await loadActiveService(deps.db, auth.organizationId, input.serviceId);
  const candidates = input.resourceId ? [input.resourceId] : await resourcesOffering(deps.db, service.id);
  if (candidates.length === 0) {
    throw problems.unprocessable(
      "service-not-offered",
      "Service not offered",
      "No active resource offers this service.",
    );
  }

  let lastProblem: unknown = null;
  for (const resourceId of candidates) {
    try {
      const booking = await deps.db.transaction((tx) => insertBooking(tx, deps, auth, service, resourceId, input));
      deps.metrics.bookings.inc({ outcome: "created" });
      return booking;
    } catch (error) {
      if (sqlState(error)?.code !== SQLSTATE.exclusionViolation && !isSlotProblem(error)) throw error;
      lastProblem = error;
    }
  }

  deps.metrics.bookings.inc({ outcome: "conflict" });
  if (isSlotProblem(lastProblem) && candidates.length === 1) throw lastProblem;
  throw problems.conflict(
    "slot-unavailable",
    "Slot unavailable",
    candidates.length === 1
      ? "Another booking holds this resource at that time."
      : "Every resource offering this service is busy at that time.",
  );
}

async function insertBooking(
  tx: Executor,
  deps: Pick<Deps, "clock">,
  auth: AuthContext,
  service: ServiceRow,
  resourceId: string,
  input: NewBooking,
): Promise<Booking> {
  const resource = await lockResource(tx, auth.organizationId, resourceId);
  await assertOffers(tx, service.id, resourceId);
  await assertBookable(tx, resource, service, input.startsAt, deps.clock.now(), auth);

  const end = input.startsAt.add({ minutes: service.durationMinutes });
  const blocked = blockedInterval({ start: input.startsAt, end }, service);
  const [row] = await tx
    .insert(bookings)
    .values({
      id: uuidv7(),
      organizationId: auth.organizationId,
      resourceId,
      serviceId: service.id,
      startsAt: toDate(input.startsAt),
      endsAt: toDate(end),
      blockedFrom: toDate(blocked.start),
      blockedUntil: toDate(blocked.end),
      customerName: input.customer.name,
      customerEmail: input.customer.email,
      customerPhone: input.customer.phone ?? null,
      notes: input.notes ?? null,
      metadata: input.metadata ?? {},
    })
    .returning();
  const booking = toBooking(row as BookingRow, resource.timezone);
  await recordEvent(tx, auth.organizationId, "booking.created", serializeBooking(booking), toDate(deps.clock.now()));
  return booking;
}

export async function cancelBooking(
  deps: Pick<Deps, "db" | "clock" | "metrics">,
  auth: AuthContext,
  id: string,
  reason: string | null,
): Promise<Booking> {
  return deps.db.transaction(async (tx) => {
    const now = toDate(deps.clock.now());
    const [row] = await tx
      .update(bookings)
      .set({ status: "cancelled", cancelledAt: now, cancellationReason: reason, updatedAt: now })
      .where(
        and(eq(bookings.id, id), eq(bookings.organizationId, auth.organizationId), eq(bookings.status, "confirmed")),
      )
      .returning();
    if (!row) {
      const existing = await getBooking(tx, auth.organizationId, id);
      if (!existing) throw problems.notFound("Booking");
      throw problems.conflict("booking-cancelled", "Booking already cancelled");
    }
    const booking = toBooking(row, await timezoneOf(tx, row.resourceId));
    await recordEvent(tx, auth.organizationId, "booking.cancelled", serializeBooking(booking), now);
    deps.metrics.bookings.inc({ outcome: "cancelled" });
    return booking;
  });
}

/** Moves a booking to another start (and optionally another resource) atomically. */
export async function rescheduleBooking(
  deps: Pick<Deps, "db" | "clock" | "metrics">,
  auth: AuthContext,
  id: string,
  change: { startsAt: Temporal.Instant; resourceId?: string | undefined },
): Promise<Booking> {
  try {
    return await deps.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(bookings)
        .where(and(eq(bookings.id, id), eq(bookings.organizationId, auth.organizationId)))
        .for("update");
      if (!current) throw problems.notFound("Booking");
      if (current.status !== "confirmed") throw problems.conflict("booking-cancelled", "Booking already cancelled");

      const resourceId = change.resourceId ?? current.resourceId;
      const service = await loadActiveService(tx, auth.organizationId, current.serviceId);
      const resource = await lockResource(tx, auth.organizationId, resourceId);
      await assertOffers(tx, service.id, resourceId);
      await assertBookable(tx, resource, service, change.startsAt, deps.clock.now(), auth);

      const end = change.startsAt.add({ minutes: service.durationMinutes });
      const blocked = blockedInterval({ start: change.startsAt, end }, service);
      const [row] = await tx
        .update(bookings)
        .set({
          resourceId,
          startsAt: toDate(change.startsAt),
          endsAt: toDate(end),
          blockedFrom: toDate(blocked.start),
          blockedUntil: toDate(blocked.end),
          updatedAt: toDate(deps.clock.now()),
        })
        .where(eq(bookings.id, id))
        .returning();
      const booking = toBooking(row as BookingRow, resource.timezone);
      await recordEvent(
        tx,
        auth.organizationId,
        "booking.rescheduled",
        {
          ...serializeBooking(booking),
          previous: {
            resourceId: current.resourceId,
            startsAt: current.startsAt.toISOString(),
            endsAt: current.endsAt.toISOString(),
          },
        },
        toDate(deps.clock.now()),
      );
      deps.metrics.bookings.inc({ outcome: "rescheduled" });
      return booking;
    });
  } catch (error) {
    if (sqlState(error)?.code === SQLSTATE.exclusionViolation) {
      deps.metrics.bookings.inc({ outcome: "conflict" });
      throw problems.conflict(
        "slot-unavailable",
        "Slot unavailable",
        "Another booking holds this resource at that time.",
      );
    }
    throw error;
  }
}

export async function getBooking(db: Executor, organizationId: string, id: string): Promise<Booking | null> {
  const [row] = await db
    .select({ booking: bookings, timezone: resources.timezone })
    .from(bookings)
    .innerJoin(resources, eq(resources.id, bookings.resourceId))
    .where(and(eq(bookings.id, id), eq(bookings.organizationId, organizationId)))
    .limit(1);
  return row ? toBooking(row.booking, row.timezone) : null;
}

export interface BookingFilter {
  resourceId?: string | undefined;
  status?: "confirmed" | "cancelled" | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

/** Keyset pagination on (starts_at, id): stable under inserts, no OFFSET scans. */
export async function listBookings(
  db: Executor,
  organizationId: string,
  filter: BookingFilter,
  page: { limit: number; after?: { startsAt: Date; id: string } | undefined },
): Promise<Booking[]> {
  const rows = await db
    .select({ booking: bookings, timezone: resources.timezone })
    .from(bookings)
    .innerJoin(resources, eq(resources.id, bookings.resourceId))
    .where(
      and(
        eq(bookings.organizationId, organizationId),
        filter.resourceId ? eq(bookings.resourceId, filter.resourceId) : undefined,
        filter.status ? eq(bookings.status, filter.status) : undefined,
        filter.from ? gte(bookings.startsAt, filter.from) : undefined,
        filter.to ? lt(bookings.startsAt, filter.to) : undefined,
        page.after
          ? or(
              gt(bookings.startsAt, page.after.startsAt),
              and(eq(bookings.startsAt, page.after.startsAt), gt(bookings.id, page.after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(bookings.startsAt), asc(bookings.id))
    .limit(page.limit);
  return rows.map((row) => toBooking(row.booking, row.timezone));
}

// ---------- helpers ----------

type BookingRow = typeof bookings.$inferSelect;

async function lockResource(tx: Executor, organizationId: string, resourceId: string) {
  // A share lock: bookings on the same resource still run in parallel (the constraint arbitrates
  // between them), but adding time off, which takes FOR UPDATE, waits for them and vice versa.
  const [resource] = await tx
    .select({ id: resources.id, timezone: resources.timezone, active: resources.active })
    .from(resources)
    .where(and(eq(resources.id, resourceId), eq(resources.organizationId, organizationId)))
    .for("share");
  if (!resource) throw problems.notFound("Resource");
  if (!resource.active)
    throw problems.unprocessable("resource-inactive", "Resource inactive", "This resource is not bookable.");
  return resource;
}

async function assertOffers(tx: Executor, serviceId: string, resourceId: string): Promise<void> {
  const [link] = await tx
    .select({ serviceId: serviceResources.serviceId })
    .from(serviceResources)
    .where(and(eq(serviceResources.serviceId, serviceId), eq(serviceResources.resourceId, resourceId)))
    .limit(1);
  if (!link) {
    throw problems.unprocessable(
      "service-not-offered",
      "Service not offered",
      "That resource does not offer this service.",
    );
  }
}

async function assertBookable(
  tx: Executor,
  resource: { id: string; timezone: string },
  service: ServiceRow,
  start: Temporal.Instant,
  now: Temporal.Instant,
  auth: AuthContext,
): Promise<void> {
  const end = start.add({ minutes: service.durationMinutes });
  const guard = blockedInterval({ start, end }, service);
  const [hours, offTime] = await Promise.all([
    tx.select().from(openingHours).where(eq(openingHours.resourceId, resource.id)),
    tx
      .select({ from: timeOff.startsAt, until: timeOff.endsAt })
      .from(timeOff)
      .where(
        and(
          eq(timeOff.resourceId, resource.id),
          lt(timeOff.startsAt, toDate(guard.end)),
          gt(timeOff.endsAt, toDate(guard.start)),
        ),
      ),
  ]);
  const problem = checkStart(
    { timezone: resource.timezone, openingHours: hours.map(toOpeningHours), service },
    offTime.map((row) => toInterval(row.from, row.until)),
    start,
    now,
    { customerRules: auth.kind === "publishable" },
  );
  if (problem) {
    throw problems.unprocessable("slot-not-bookable", "Slot not bookable", START_PROBLEM_TEXT[problem], {
      reason: problem,
    });
  }
}

async function resourcesOffering(db: Executor, serviceId: string): Promise<string[]> {
  const rows = await db
    .select({ id: resources.id })
    .from(serviceResources)
    .innerJoin(resources, eq(resources.id, serviceResources.resourceId))
    .where(and(eq(serviceResources.serviceId, serviceId), eq(resources.active, true), eq(resources.hidden, false)))
    .orderBy(asc(resources.id));
  return rows.map((row) => row.id);
}

async function timezoneOf(db: Executor, resourceId: string): Promise<string> {
  const [row] = await db.select({ timezone: resources.timezone }).from(resources).where(eq(resources.id, resourceId));
  return row?.timezone ?? "UTC";
}

function isSlotProblem(error: unknown): boolean {
  return error instanceof Error && "slug" in error && error.slug === "slot-not-bookable";
}

function toBooking(row: BookingRow, timezone: string): Booking {
  return {
    id: row.id,
    resourceId: row.resourceId,
    serviceId: row.serviceId,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    timezone,
    customer: { name: row.customerName, email: row.customerEmail, phone: row.customerPhone },
    notes: row.notes,
    metadata: row.metadata,
    cancelledAt: row.cancelledAt,
    cancellationReason: row.cancellationReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Booking as it travels in events and webhooks: plain JSON, local times with offsets. */
export function serializeBooking(booking: Booking) {
  return {
    id: booking.id,
    object: "booking" as const,
    resourceId: booking.resourceId,
    serviceId: booking.serviceId,
    status: booking.status,
    startsAt: localIso(booking.startsAt, booking.timezone),
    endsAt: localIso(booking.endsAt, booking.timezone),
    timezone: booking.timezone,
    customer: booking.customer,
    notes: booking.notes,
    metadata: booking.metadata,
    cancelledAt: booking.cancelledAt?.toISOString() ?? null,
    cancellationReason: booking.cancellationReason,
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
  };
}

/** RFC 3339 with the zone's offset, e.g. 2026-10-27T19:30:00+01:00: unambiguous and readable. */
export function localIso(date: Date, timezone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime())
    .toZonedDateTimeISO(timezone)
    .toString({ timeZoneName: "never", smallestUnit: "second" });
}

export function toDate(instant: Temporal.Instant): Date {
  return new Date(instant.epochMilliseconds);
}
