import { and, desc, eq, gt, lt } from "drizzle-orm";
import type { AuthContext, Deps } from "../context";
import { PUBLISHABLE_SCOPES } from "../context";
import {
  apiKeys,
  bookings,
  demoInbox,
  events,
  organizations,
  resources,
  services,
  webhookEndpoints,
} from "../db/schema";
import { blockedInterval } from "../domain/availability";
import { hmacSha256, sha256Hex, uuidv7 } from "../lib/crypto";
import { createResource, createService } from "./catalog";
import { verify as verifySignature } from "./webhooks";

export const DEMO_SLUG = "demo-padel-club";
export const RACE_ATTEMPTS = 200;
const RACE_TICKET_SECONDS = 120;

export interface DemoInfo {
  organizationId: string;
  name: string;
  timezone: string;
  publishableKey: string;
  courts: { id: string; name: string }[];
  matchServiceId: string;
  lessonServiceId: string;
  raceResourceId: string;
  raceServiceId: string;
}

let cached: DemoInfo | null = null;

/**
 * The demo's credentials are derived from APP_SECRET instead of stored: the landing page can show
 * the publishable key (it is public by design) and the webhook receiver can verify signatures,
 * and both survive a reseed.
 */
async function demoCredentials(appSecret: string) {
  const key = await hmacSha256(appSecret, "slotlock/demo/publishable-key");
  const webhook = await hmacSha256(appSecret, "slotlock/demo/webhook-secret");
  return {
    publishableKey: `sl_pk_demo${Buffer.from(key).toString("base64url").slice(0, 32)}`,
    webhookSecret: `whsec_${Buffer.from(webhook).toString("base64")}`,
  };
}

/** Creates the demo club on first use; afterwards just reads it. Safe to call concurrently. */
export async function ensureDemo(deps: Deps): Promise<DemoInfo> {
  if (cached) return cached;
  const credentials = await demoCredentials(deps.config.appSecret);
  const [existing] = await deps.db.select().from(organizations).where(eq(organizations.slug, DEMO_SLUG));
  if (!existing) {
    await seedDemo(deps, credentials).catch(async (error) => {
      // Another instance won the race to seed; use its club.
      const [winner] = await deps.db.select().from(organizations).where(eq(organizations.slug, DEMO_SLUG));
      if (!winner) throw error;
    });
  }
  cached = await loadDemo(deps, credentials.publishableKey);
  return cached;
}

async function loadDemo(deps: Deps, publishableKey: string): Promise<DemoInfo> {
  const [org] = await deps.db.select().from(organizations).where(eq(organizations.slug, DEMO_SLUG));
  if (!org) throw new Error("demo organization missing");
  const resourceRows = await deps.db.select().from(resources).where(eq(resources.organizationId, org.id));
  const serviceRows = await deps.db.select().from(services).where(eq(services.organizationId, org.id));
  const byKey = (key: string) => {
    const row = serviceRows.find((service) => service.name.startsWith(key));
    if (!row) throw new Error(`demo service ${key} missing`);
    return row.id;
  };
  const race = resourceRows.find((resource) => resource.hidden);
  if (!race) throw new Error("demo race court missing");
  return {
    organizationId: org.id,
    name: org.name,
    timezone: org.timezone,
    publishableKey,
    courts: resourceRows
      .filter((resource) => !resource.hidden)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((resource) => ({ id: resource.id, name: resource.name })),
    matchServiceId: byKey("Match"),
    lessonServiceId: byKey("Lesson"),
    raceResourceId: race.id,
    raceServiceId: byKey("Race"),
  };
}

async function seedDemo(deps: Deps, credentials: { publishableKey: string; webhookSecret: string }) {
  const organizationId = uuidv7();
  const timezone = "Europe/Madrid";
  await deps.db
    .insert(organizations)
    .values({ id: organizationId, name: "Demo Padel Club", slug: DEMO_SLUG, timezone });

  const weekday = (opensAt: string, closesAt: string) =>
    [1, 2, 3, 4, 5].map((day) => ({ weekday: day, opensAt, closesAt }));
  const weekend = (opensAt: string, closesAt: string) => [6, 7].map((day) => ({ weekday: day, opensAt, closesAt }));
  const clubHours = [...weekday("08:00", "23:00"), ...weekend("09:00", "21:00")];
  const courts = [];
  for (const [name, surface] of [
    ["Court 1", "glass"],
    ["Court 2", "glass"],
    ["Court 3", "panoramic"],
    ["Court 4", "indoor"],
  ] as const) {
    courts.push(
      await createResource(deps.db, organizationId, { name, timezone, metadata: { surface }, openingHours: clubHours }),
    );
  }
  const raceCourt = await createResource(deps.db, organizationId, {
    name: "Center Court (race)",
    timezone,
    openingHours: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ weekday: day, opensAt: "00:00", closesAt: "24:00" })),
  });
  await deps.db.update(resources).set({ hidden: true }).where(eq(resources.id, raceCourt.id));

  const courtIds = courts.map((court) => court.id);
  await createService(deps.db, organizationId, {
    name: "Match · 90 min",
    durationMinutes: 90,
    bufferAfterMinutes: 10,
    slotIntervalMinutes: 30,
    minNoticeMinutes: 30,
    maxAdvanceDays: 14,
    price: { amountCents: 2800, currency: "EUR" },
    resourceIds: courtIds,
  });
  await createService(deps.db, organizationId, {
    name: "Lesson · 60 min",
    durationMinutes: 60,
    bufferAfterMinutes: 10,
    slotIntervalMinutes: 60,
    minNoticeMinutes: 120,
    maxAdvanceDays: 14,
    price: { amountCents: 3500, currency: "EUR" },
    resourceIds: courtIds,
  });
  await createService(deps.db, organizationId, {
    name: "Race · 60 min",
    durationMinutes: 60,
    slotIntervalMinutes: 60,
    minNoticeMinutes: 0,
    maxAdvanceDays: 730,
    resourceIds: [raceCourt.id],
  });

  await deps.db.insert(apiKeys).values({
    id: uuidv7(),
    organizationId,
    name: "Landing page widget",
    kind: "publishable",
    prefix: credentials.publishableKey.slice(0, 12),
    keyHash: sha256Hex(credentials.publishableKey),
    scopes: [...PUBLISHABLE_SCOPES],
  });
  await deps.db.insert(webhookEndpoints).values({
    id: uuidv7(),
    organizationId,
    url: `${deps.config.publicUrl}/demo/webhooks`,
    description: "Demo receiver: verifies signatures and shows deliveries on the landing page",
    events: ["*"],
    secretCiphertext: await deps.secrets.encrypt(credentials.webhookSecret),
  });
  await seedBookings(deps, organizationId, timezone, courtIds);
}

/**
 * Wipes visitors' bookings and refills the next week with a believable club calendar:
 * busy evenings, quieter mornings, the same pattern for the same date every time.
 */
export async function resetDemo(deps: Deps): Promise<{ removed: number; seeded: number }> {
  const demo = await ensureDemo(deps);
  const removed = await deps.db
    .delete(bookings)
    .where(eq(bookings.organizationId, demo.organizationId))
    .returning({ id: bookings.id });
  const dayAgo = new Date(deps.clock.now().epochMilliseconds - 86_400_000);
  await deps.db.delete(events).where(and(eq(events.organizationId, demo.organizationId), lt(events.createdAt, dayAgo)));
  const seeded = await seedBookings(
    deps,
    demo.organizationId,
    demo.timezone,
    demo.courts.map((court) => court.id),
  );
  return { removed: removed.length, seeded };
}

async function seedBookings(deps: Deps, organizationId: string, timezone: string, courtIds: string[]): Promise<number> {
  const [match] = await deps.db
    .select()
    .from(services)
    .where(and(eq(services.organizationId, organizationId), eq(services.durationMinutes, 90)));
  if (!match) return 0;
  const today = deps.clock.now().toZonedDateTimeISO(timezone).toPlainDate();
  const rows: (typeof bookings.$inferInsert)[] = [];
  const names = ["Lucía", "Mateo", "Carmen", "Hugo", "Martina", "Pablo", "Sofía", "Álvaro", "Valeria", "Diego"];
  for (let offset = 0; offset < 7; offset++) {
    const date = today.add({ days: offset });
    const weekend = date.dayOfWeek >= 6;
    const opens = weekend ? 9 * 60 : 8 * 60;
    const closes = weekend ? 21 * 60 : 23 * 60;
    for (const [index, courtId] of courtIds.entries()) {
      const random = seeded(`${date.toString()}#${index}`);
      // Walk the day in 100-minute steps (a match plus cleanup), booking more often at peak hours.
      for (let minute = opens; minute + 90 <= closes; minute += 100) {
        const peak = minute >= 17 * 60 || (weekend && minute >= 10 * 60);
        if (random() > (peak ? 0.72 : 0.28)) continue;
        const start = date
          .toZonedDateTime({
            timeZone: timezone,
            plainTime: new Temporal.PlainTime(Math.floor(minute / 60), minute % 60),
          })
          .toInstant();
        const end = start.add({ minutes: 90 });
        const blocked = blockedInterval({ start, end }, match);
        const name = names[Math.floor(random() * names.length)] ?? "Lucía";
        rows.push({
          id: uuidv7(),
          organizationId,
          resourceId: courtId,
          serviceId: match.id,
          startsAt: new Date(start.epochMilliseconds),
          endsAt: new Date(end.epochMilliseconds),
          blockedFrom: new Date(blocked.start.epochMilliseconds),
          blockedUntil: new Date(blocked.end.epochMilliseconds),
          customerName: name,
          customerEmail: `${name
            .toLowerCase()
            .normalize("NFD")
            .replace(/[^a-z]/g, "")}@example.com`,
          metadata: { source: "seed" },
        });
      }
    }
  }
  if (rows.length > 0) await deps.db.insert(bookings).values(rows);
  return rows.length;
}

// ---------- the race ----------

export interface Race {
  raceId: string;
  ticket: string;
  resourceId: string;
  serviceId: string;
  startsAt: string;
  attempts: number;
  expiresAt: string;
}

/**
 * Prepares a race: a free hour on the hidden race court far in the future, and a signed ticket
 * that lets the browser spend a bounded burst of booking attempts on it.
 */
export async function startRace(deps: Deps): Promise<Race> {
  const demo = await ensureDemo(deps);
  const now = deps.clock.now();
  const today = now.toZonedDateTimeISO(demo.timezone).toPlainDate();
  let startsAt = now;
  for (let tries = 0; tries < 8; tries++) {
    // An evening hour (17:00–22:00, when everyone wants a court) in the next two months:
    // plenty of distinct slots for concurrent visitors, and dates that look like a real club's.
    const day = today.add({ days: 1 + Math.floor(Math.random() * 59) });
    const hour = 17 + Math.floor(Math.random() * 6);
    startsAt = day.toZonedDateTime({ timeZone: demo.timezone, plainTime: new Temporal.PlainTime(hour) }).toInstant();
    const taken = await deps.db
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.resourceId, demo.raceResourceId),
          eq(bookings.status, "confirmed"),
          lt(bookings.blockedFrom, new Date(startsAt.add({ hours: 1 }).epochMilliseconds)),
          gt(bookings.blockedUntil, new Date(startsAt.epochMilliseconds)),
        ),
      )
      .limit(1);
    if (taken.length === 0) break;
  }
  const raceId = uuidv7();
  const expires = Math.floor(now.epochMilliseconds / 1000) + RACE_TICKET_SECONDS;
  const ticket = await deps.secrets.sign(`race:${raceId}:${demo.raceResourceId}:${expires}`);
  return {
    raceId,
    ticket,
    resourceId: demo.raceResourceId,
    serviceId: demo.raceServiceId,
    startsAt: startsAt.toZonedDateTimeISO(demo.timezone).toString({ timeZoneName: "never", smallestUnit: "second" }),
    attempts: RACE_ATTEMPTS,
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}

// ---------- webhook receiver ----------

/** The demo's own webhook receiver: verifies like a real one would, and keeps what it got. */
export async function receiveWebhook(
  deps: Deps,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
): Promise<boolean> {
  const { webhookSecret } = await demoCredentials(deps.config.appSecret);
  const nowSeconds = Math.floor(deps.clock.now().epochMilliseconds / 1000);
  const valid = await verifySignature(webhookSecret, headers, body, nowSeconds);
  let payload: { type?: string } & Record<string, unknown> = {};
  try {
    payload = JSON.parse(body);
  } catch {
    payload = { raw: body.slice(0, 500) };
  }
  await deps.db.insert(demoInbox).values({
    id: uuidv7(),
    webhookId: headers.id ?? "missing",
    eventType: typeof payload.type === "string" ? payload.type : "unknown",
    signatureValid: valid,
    payload,
    // The application clock, like the events it is compared with on the page.
    receivedAt: new Date(deps.clock.now().epochMilliseconds),
  });
  return valid;
}

export interface FeedItem {
  kind: "event" | "webhook";
  id: string;
  type: string;
  at: string;
  data: Record<string, unknown>;
  signatureValid?: boolean;
}

/** Recent demo activity after a cursor, for the landing page's live log. */
export async function feedSince(deps: Deps, after: { event: string; inbox: string }): Promise<FeedItem[]> {
  const demo = await ensureDemo(deps);
  const [eventRows, inboxRows] = await Promise.all([
    deps.db
      .select()
      .from(events)
      .where(and(eq(events.organizationId, demo.organizationId), gt(events.id, after.event)))
      .orderBy(events.id)
      .limit(50),
    deps.db.select().from(demoInbox).where(gt(demoInbox.id, after.inbox)).orderBy(demoInbox.id).limit(50),
  ]);
  return [
    ...eventRows.map((row) => ({
      kind: "event" as const,
      id: row.id,
      type: row.type,
      at: row.createdAt.toISOString(),
      data: row.data,
    })),
    ...inboxRows.map((row) => ({
      kind: "webhook" as const,
      id: row.id,
      type: row.eventType,
      at: row.receivedAt.toISOString(),
      data: row.payload,
      signatureValid: row.signatureValid,
    })),
  ].sort((a, b) => a.id.localeCompare(b.id));
}

export async function latestFeedCursor(deps: Deps): Promise<{ event: string; inbox: string }> {
  const demo = await ensureDemo(deps);
  const zero = "00000000-0000-0000-0000-000000000000";
  const [[event], [inbox]] = await Promise.all([
    deps.db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.organizationId, demo.organizationId))
      .orderBy(desc(events.id))
      .limit(1),
    deps.db.select({ id: demoInbox.id }).from(demoInbox).orderBy(desc(demoInbox.id)).limit(1),
  ]);
  return { event: event?.id ?? zero, inbox: inbox?.id ?? zero };
}

/** The auth context the demo acts with when it calls services directly. */
export function demoAuth(demo: DemoInfo): AuthContext {
  return {
    organizationId: demo.organizationId,
    timezone: demo.timezone,
    keyId: "demo",
    kind: "publishable",
    scopes: new Set(PUBLISHABLE_SCOPES),
  };
}

/** Clears the per-instance cache (tests reseed between cases). */
export function forgetDemo(): void {
  cached = null;
}

/** Small deterministic PRNG (mulberry32) seeded from a string: same date, same calendar. */
function seeded(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
