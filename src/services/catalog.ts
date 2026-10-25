import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { bookings, openingHours, resources, serviceResources, services, timeOff } from "../db/schema";
import { formatClock, parseClock } from "../domain/availability";
import { uuidv7 } from "../lib/crypto";
import { problems } from "../lib/problem";

export interface OpeningHoursEntry {
  weekday: number;
  opensAt: string;
  closesAt: string;
}

export interface Resource {
  id: string;
  name: string;
  timezone: string;
  active: boolean;
  metadata: Record<string, string>;
  openingHours: OpeningHoursEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Service {
  id: string;
  name: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  slotIntervalMinutes: number;
  minNoticeMinutes: number;
  maxAdvanceDays: number;
  price: { amountCents: number; currency: string } | null;
  active: boolean;
  resourceIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface TimeOff {
  id: string;
  resourceId: string;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
  createdAt: Date;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    Temporal.Now.zonedDateTimeISO(timeZone);
    return true;
  } catch {
    return false;
  }
}

// ---------- resources ----------

export async function createResource(
  db: Executor,
  organizationId: string,
  input: {
    name: string;
    timezone: string;
    active?: boolean;
    metadata?: Record<string, string>;
    openingHours?: OpeningHoursEntry[];
  },
): Promise<Resource> {
  const id = uuidv7();
  await db.transaction(async (tx) => {
    await tx.insert(resources).values({
      id,
      organizationId,
      name: input.name,
      timezone: input.timezone,
      active: input.active ?? true,
      metadata: input.metadata ?? {},
    });
    if (input.openingHours?.length) await writeOpeningHours(tx, id, input.openingHours);
  });
  return (await getResource(db, organizationId, id)) as Resource;
}

export async function listResources(
  db: Executor,
  organizationId: string,
  page: { limit: number; after?: string },
): Promise<Resource[]> {
  const rows = await db
    .select()
    .from(resources)
    .where(
      and(
        eq(resources.organizationId, organizationId),
        eq(resources.hidden, false),
        page.after ? gt(resources.id, page.after) : undefined,
      ),
    )
    .orderBy(asc(resources.id))
    .limit(page.limit);
  const hours = await hoursFor(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toResource(row, hours.get(row.id) ?? []));
}

export async function getResource(db: Executor, organizationId: string, id: string): Promise<Resource | null> {
  const [row] = await db
    .select()
    .from(resources)
    .where(and(eq(resources.id, id), eq(resources.organizationId, organizationId)))
    .limit(1);
  if (!row) return null;
  const hours = await hoursFor(db, [id]);
  return toResource(row, hours.get(id) ?? []);
}

export async function updateResource(
  db: Executor,
  organizationId: string,
  id: string,
  patch: {
    name?: string;
    timezone?: string;
    active?: boolean;
    metadata?: Record<string, string>;
    openingHours?: OpeningHoursEntry[];
  },
): Promise<Resource> {
  await db.transaction(async (tx) => {
    const { openingHours: hours, ...fields } = patch;
    const updated = await tx
      .update(resources)
      .set({ ...fields, updatedAt: new Date() })
      .where(and(eq(resources.id, id), eq(resources.organizationId, organizationId)))
      .returning({ id: resources.id });
    if (updated.length === 0) throw problems.notFound("Resource");
    if (hours) {
      await tx.delete(openingHours).where(eq(openingHours.resourceId, id));
      await writeOpeningHours(tx, id, hours);
    }
  });
  return (await getResource(db, organizationId, id)) as Resource;
}

/** Opening hours must not overlap within a day; touching (13:00–14:00 then 14:00–18:00) is fine. */
export function validateOpeningHours(entries: OpeningHoursEntry[]): string | null {
  const parsed = entries.map((entry) => ({
    ...entry,
    opens: parseClock(entry.opensAt),
    closes: parseClock(entry.closesAt),
  }));
  for (const entry of parsed) {
    if (entry.opens >= entry.closes) return `${entry.opensAt}–${entry.closesAt} closes before it opens`;
  }
  for (let weekday = 1; weekday <= 7; weekday++) {
    const day = parsed.filter((entry) => entry.weekday === weekday).sort((a, b) => a.opens - b.opens);
    for (let i = 1; i < day.length; i++) {
      const previous = day[i - 1];
      const current = day[i];
      if (previous && current && current.opens < previous.closes) {
        return `${previous.opensAt}–${previous.closesAt} and ${current.opensAt}–${current.closesAt} overlap on weekday ${weekday}`;
      }
    }
  }
  return null;
}

async function writeOpeningHours(db: Executor, resourceId: string, entries: OpeningHoursEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await db.insert(openingHours).values(
    entries.map((entry) => ({
      id: uuidv7(),
      resourceId,
      weekday: entry.weekday,
      opensAt: toDbTime(parseClock(entry.opensAt)),
      closesAt: toDbTime(parseClock(entry.closesAt)),
    })),
  );
}

async function hoursFor(db: Executor, resourceIds: string[]): Promise<Map<string, OpeningHoursEntry[]>> {
  const byResource = new Map<string, OpeningHoursEntry[]>();
  if (resourceIds.length === 0) return byResource;
  const rows = await db
    .select()
    .from(openingHours)
    .where(inArray(openingHours.resourceId, resourceIds))
    .orderBy(asc(openingHours.weekday), asc(openingHours.opensAt));
  for (const row of rows) {
    const list = byResource.get(row.resourceId) ?? [];
    list.push({
      weekday: row.weekday,
      opensAt: formatClock(fromDbTime(row.opensAt)),
      closesAt: formatClock(fromDbTime(row.closesAt)),
    });
    byResource.set(row.resourceId, list);
  }
  return byResource;
}

function toResource(row: typeof resources.$inferSelect, hours: OpeningHoursEntry[]): Resource {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    active: row.active,
    metadata: row.metadata,
    openingHours: hours,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Postgres `time` allows 24:00:00, which is exactly what "open until midnight" needs. */
export function toDbTime(minutes: number): string {
  return `${formatClock(minutes)}:00`;
}

export function fromDbTime(value: string): number {
  const [hours, minutes] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

// ---------- time off ----------

export async function addTimeOff(
  db: Executor,
  organizationId: string,
  resourceId: string,
  input: { startsAt: Date; endsAt: Date; reason?: string | undefined },
): Promise<TimeOff> {
  return db.transaction(async (tx) => {
    // Locking the resource row serializes time off against bookings, which take a share lock on it.
    const [resource] = await tx
      .select({ id: resources.id })
      .from(resources)
      .where(and(eq(resources.id, resourceId), eq(resources.organizationId, organizationId)))
      .for("update");
    if (!resource) throw problems.notFound("Resource");

    const clashes = await tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.resourceId, resourceId),
          eq(bookings.status, "confirmed"),
          lt(bookings.blockedFrom, input.endsAt),
          gt(bookings.blockedUntil, input.startsAt),
        ),
      )
      .limit(20);
    if (clashes.length > 0) {
      throw problems.conflict(
        "time-off-conflict",
        "Time off overlaps confirmed bookings",
        "Cancel or reschedule these bookings first.",
        { bookingIds: clashes.map((clash) => clash.id) },
      );
    }
    const [row] = await tx
      .insert(timeOff)
      .values({
        id: uuidv7(),
        resourceId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        reason: input.reason ?? null,
      })
      .returning();
    return row as TimeOff;
  });
}

export async function listTimeOff(
  db: Executor,
  organizationId: string,
  resourceId: string,
  range: { from: Date; to: Date },
): Promise<TimeOff[]> {
  const rows = await db
    .select({ timeOff })
    .from(timeOff)
    .innerJoin(resources, eq(resources.id, timeOff.resourceId))
    .where(
      and(
        eq(timeOff.resourceId, resourceId),
        eq(resources.organizationId, organizationId),
        lt(timeOff.startsAt, range.to),
        gt(timeOff.endsAt, range.from),
      ),
    )
    .orderBy(asc(timeOff.startsAt));
  return rows.map((row) => row.timeOff);
}

export async function deleteTimeOff(
  db: Executor,
  organizationId: string,
  resourceId: string,
  id: string,
): Promise<void> {
  const deleted = await db
    .delete(timeOff)
    .where(
      and(
        eq(timeOff.id, id),
        eq(timeOff.resourceId, resourceId),
        sql`exists (select 1 from ${resources} where ${resources.id} = ${timeOff.resourceId} and ${resources.organizationId} = ${organizationId})`,
      ),
    )
    .returning({ id: timeOff.id });
  if (deleted.length === 0) throw problems.notFound("Time off");
}

// ---------- services ----------

type ServiceFields = {
  name: string;
  durationMinutes: number;
  bufferBeforeMinutes?: number | undefined;
  bufferAfterMinutes?: number | undefined;
  slotIntervalMinutes?: number | undefined;
  minNoticeMinutes?: number | undefined;
  maxAdvanceDays?: number | undefined;
  price?: { amountCents: number; currency: string } | null | undefined;
  active?: boolean | undefined;
  resourceIds: string[];
};

export async function createService(db: Executor, organizationId: string, input: ServiceFields): Promise<Service> {
  const id = uuidv7();
  await db.transaction(async (tx) => {
    await assertResourcesBelong(tx, organizationId, input.resourceIds);
    await tx.insert(services).values({
      id,
      organizationId,
      name: input.name,
      durationMinutes: input.durationMinutes,
      bufferBeforeMinutes: input.bufferBeforeMinutes ?? 0,
      bufferAfterMinutes: input.bufferAfterMinutes ?? 0,
      slotIntervalMinutes: input.slotIntervalMinutes ?? Math.min(input.durationMinutes, 30),
      minNoticeMinutes: input.minNoticeMinutes ?? 60,
      maxAdvanceDays: input.maxAdvanceDays ?? 60,
      priceCents: input.price?.amountCents ?? null,
      currency: input.price?.currency ?? null,
      active: input.active ?? true,
    });
    if (input.resourceIds.length > 0) {
      await tx.insert(serviceResources).values(input.resourceIds.map((resourceId) => ({ serviceId: id, resourceId })));
    }
  });
  return (await getService(db, organizationId, id)) as Service;
}

export async function updateService(
  db: Executor,
  organizationId: string,
  id: string,
  patch: Partial<ServiceFields>,
): Promise<Service> {
  await db.transaction(async (tx) => {
    const { resourceIds, price, ...fields } = patch;
    const updated = await tx
      .update(services)
      .set({
        ...fields,
        ...(price !== undefined ? { priceCents: price?.amountCents ?? null, currency: price?.currency ?? null } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(services.id, id), eq(services.organizationId, organizationId)))
      .returning({ id: services.id });
    if (updated.length === 0) throw problems.notFound("Service");
    if (resourceIds) {
      await assertResourcesBelong(tx, organizationId, resourceIds);
      await tx.delete(serviceResources).where(eq(serviceResources.serviceId, id));
      if (resourceIds.length > 0) {
        await tx.insert(serviceResources).values(resourceIds.map((resourceId) => ({ serviceId: id, resourceId })));
      }
    }
  });
  return (await getService(db, organizationId, id)) as Service;
}

export async function listServices(
  db: Executor,
  organizationId: string,
  page: { limit: number; after?: string },
): Promise<Service[]> {
  const rows = await db
    .select()
    .from(services)
    .where(and(eq(services.organizationId, organizationId), page.after ? gt(services.id, page.after) : undefined))
    .orderBy(asc(services.id))
    .limit(page.limit);
  const links = await resourceLinks(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toService(row, links.get(row.id) ?? []));
}

export async function getService(db: Executor, organizationId: string, id: string): Promise<Service | null> {
  const [row] = await db
    .select()
    .from(services)
    .where(and(eq(services.id, id), eq(services.organizationId, organizationId)))
    .limit(1);
  if (!row) return null;
  const links = await resourceLinks(db, [id]);
  return toService(row, links.get(id) ?? []);
}

async function assertResourcesBelong(db: Executor, organizationId: string, resourceIds: string[]): Promise<void> {
  if (resourceIds.length === 0) return;
  const found = await db
    .select({ id: resources.id })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), inArray(resources.id, resourceIds)));
  const known = new Set(found.map((row) => row.id));
  const missing = resourceIds.filter((resourceId) => !known.has(resourceId));
  if (missing.length > 0) {
    throw problems.unprocessable("unknown-resource", "Unknown resource", `No resource with id ${missing.join(", ")}.`, {
      resourceIds: missing,
    });
  }
}

async function resourceLinks(db: Executor, serviceIds: string[]): Promise<Map<string, string[]>> {
  const links = new Map<string, string[]>();
  if (serviceIds.length === 0) return links;
  const rows = await db
    .select()
    .from(serviceResources)
    .where(inArray(serviceResources.serviceId, serviceIds))
    .orderBy(asc(serviceResources.resourceId));
  for (const row of rows) links.set(row.serviceId, [...(links.get(row.serviceId) ?? []), row.resourceId]);
  return links;
}

function toService(row: typeof services.$inferSelect, resourceIds: string[]): Service {
  return {
    id: row.id,
    name: row.name,
    durationMinutes: row.durationMinutes,
    bufferBeforeMinutes: row.bufferBeforeMinutes,
    bufferAfterMinutes: row.bufferAfterMinutes,
    slotIntervalMinutes: row.slotIntervalMinutes,
    minNoticeMinutes: row.minNoticeMinutes,
    maxAdvanceDays: row.maxAdvanceDays,
    price: row.priceCents !== null && row.currency ? { amountCents: row.priceCents, currency: row.currency } : null,
    active: row.active,
    resourceIds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
