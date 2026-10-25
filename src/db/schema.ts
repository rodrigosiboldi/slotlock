import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/*
 * The schema in TypeScript, for typed queries. Two things live only in SQL migrations
 * (drizzle-kit cannot express them): the btree_gist extension and the exclusion constraint
 * on bookings that makes double booking impossible. See drizzle/0001_booking_guarantees.sql.
 */

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const instant = (name: string) => timestamp(name, { withTimezone: true });

/** Postgres' 64-bit transaction id; read as text. */
const xid8 = customType<{ data: string; driverData: string }>({ dataType: () => "xid8" });

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  timezone: text("timezone").notNull(),
  createdAt: createdAt(),
});

export const API_KEY_KINDS = ["secret", "publishable"] as const;
export type ApiKeyKind = (typeof API_KEY_KINDS)[number];

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").$type<ApiKeyKind>().notNull(),
    /** First characters of the key, safe to show in dashboards and logs. */
    prefix: text("prefix").notNull(),
    /** SHA-256 of the full key. The key itself is shown once and never stored. */
    keyHash: text("key_hash").notNull().unique(),
    scopes: text("scopes").array().notNull(),
    createdAt: createdAt(),
    lastUsedAt: instant("last_used_at"),
    revokedAt: instant("revoked_at"),
  },
  (t) => [
    index("api_keys_organization_idx").on(t.organizationId),
    check("api_keys_kind_check", sql`${t.kind} in ('secret', 'publishable')`),
  ],
);

export const resources = pgTable(
  "resources",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** IANA zone the opening hours are written in. Defaults to the organization's. */
    timezone: text("timezone").notNull(),
    active: boolean("active").notNull().default(true),
    /** Hidden resources do not show up in listings (the demo's race court). */
    hidden: boolean("hidden").notNull().default(false),
    metadata: jsonb("metadata").$type<Record<string, string>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("resources_organization_idx").on(t.organizationId, t.createdAt)],
);

export const services = pgTable(
  "services",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
    bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
    /** Distance between candidate start times, e.g. every 15 or 30 minutes. */
    slotIntervalMinutes: integer("slot_interval_minutes").notNull().default(15),
    minNoticeMinutes: integer("min_notice_minutes").notNull().default(60),
    maxAdvanceDays: integer("max_advance_days").notNull().default(60),
    priceCents: integer("price_cents"),
    currency: text("currency"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("services_organization_idx").on(t.organizationId, t.createdAt),
    check("services_duration_check", sql`${t.durationMinutes} between 5 and 720`),
    check(
      "services_buffers_check",
      sql`${t.bufferBeforeMinutes} between 0 and 240 and ${t.bufferAfterMinutes} between 0 and 240`,
    ),
    check("services_interval_check", sql`${t.slotIntervalMinutes} between 5 and 240`),
    check("services_price_check", sql`(${t.priceCents} is null) = (${t.currency} is null)`),
  ],
);

export const serviceResources = pgTable(
  "service_resources",
  {
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.serviceId, t.resourceId] }),
    index("service_resources_resource_idx").on(t.resourceId),
  ],
);

/** Weekly opening hours, in the resource's local time. ISO weekday: 1 = Monday ... 7 = Sunday. */
export const openingHours = pgTable(
  "opening_hours",
  {
    id: uuid("id").primaryKey(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    weekday: smallint("weekday").notNull(),
    opensAt: time("opens_at").notNull(),
    closesAt: time("closes_at").notNull(),
  },
  (t) => [
    index("opening_hours_resource_idx").on(t.resourceId, t.weekday),
    check("opening_hours_weekday_check", sql`${t.weekday} between 1 and 7`),
    check("opening_hours_range_check", sql`${t.opensAt} < ${t.closesAt}`),
  ],
);

export const timeOff = pgTable(
  "time_off",
  {
    id: uuid("id").primaryKey(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    startsAt: instant("starts_at").notNull(),
    endsAt: instant("ends_at").notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("time_off_resource_idx").on(t.resourceId, t.startsAt),
    check("time_off_range_check", sql`${t.startsAt} < ${t.endsAt}`),
  ],
);

export const BOOKING_STATUSES = ["confirmed", "cancelled"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "restrict" }),
    status: text("status").$type<BookingStatus>().notNull().default("confirmed"),
    startsAt: instant("starts_at").notNull(),
    endsAt: instant("ends_at").notNull(),
    /** The interval the resource is unavailable for: the booking plus the service buffers. */
    blockedFrom: instant("blocked_from").notNull(),
    blockedUntil: instant("blocked_until").notNull(),
    customerName: text("customer_name").notNull(),
    customerEmail: text("customer_email").notNull(),
    customerPhone: text("customer_phone"),
    notes: text("notes"),
    metadata: jsonb("metadata").$type<Record<string, string>>().notNull().default({}),
    cancelledAt: instant("cancelled_at"),
    cancellationReason: text("cancellation_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("bookings_organization_starts_idx").on(t.organizationId, t.startsAt, t.id),
    index("bookings_resource_blocked_idx").on(t.resourceId, t.blockedFrom),
    check("bookings_status_check", sql`${t.status} in ('confirmed', 'cancelled')`),
    check("bookings_range_check", sql`${t.startsAt} < ${t.endsAt}`),
    check("bookings_blocked_check", sql`${t.blockedFrom} <= ${t.startsAt} and ${t.blockedUntil} >= ${t.endsAt}`),
  ],
);

/** Stripe-style idempotency: replaying a key returns the stored response instead of acting twice. */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    /** Method, path and a hash of the body: the same key with a different request is rejected. */
    fingerprint: text("fingerprint").notNull(),
    responseStatus: smallint("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: createdAt(),
    completedAt: instant("completed_at"),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.key] }), index("idempotency_keys_created_idx").on(t.createdAt)],
);

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    description: text("description"),
    /** Signing secret, encrypted at rest with AES-256-GCM (see lib/secrets.ts). */
    secretCiphertext: text("secret_ciphertext").notNull(),
    events: text("events").array().notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("webhook_endpoints_organization_idx").on(t.organizationId)],
);

/** Every state change, written in the same transaction as the change itself (transactional outbox). */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    /**
     * The writing transaction. Readers page by (tx_id, id) and only past the oldest transaction
     * still running, so an event whose transaction commits late can't land behind a cursor.
     */
    txId: xid8("tx_id").notNull().default(sql`pg_current_xact_id()`),
    createdAt: createdAt(),
  },
  (t) => [index("events_feed_idx").on(t.organizationId, t.txId, t.id)],
);

export const DELIVERY_STATUSES = ["pending", "succeeded", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    status: text("status").$type<DeliveryStatus>().notNull().default("pending"),
    attempts: smallint("attempts").notNull().default(0),
    nextAttemptAt: instant("next_attempt_at").notNull().defaultNow(),
    lastAttemptAt: instant("last_attempt_at"),
    lastResponseStatus: smallint("last_response_status"),
    lastError: text("last_error"),
    lastDurationMs: integer("last_duration_ms"),
    createdAt: createdAt(),
  },
  (t) => [
    index("webhook_deliveries_due_idx").on(t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
    index("webhook_deliveries_endpoint_idx").on(t.endpointId, t.createdAt),
    uniqueIndex("webhook_deliveries_endpoint_event_idx").on(t.endpointId, t.eventId),
    check("webhook_deliveries_status_check", sql`${t.status} in ('pending', 'succeeded', 'failed')`),
  ],
);

/** Sliding-window rate limiter state: one row per (policy, subject). */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStartMs: bigint("window_start_ms", { mode: "number" }).notNull(),
  count: integer("count").notNull(),
  previousCount: integer("previous_count").notNull().default(0),
});

/** What the demo's webhook receiver got: lets the landing page show deliveries arriving. */
export const demoInbox = pgTable(
  "demo_inbox",
  {
    id: uuid("id").primaryKey(),
    webhookId: text("webhook_id").notNull(),
    eventType: text("event_type").notNull(),
    signatureValid: boolean("signature_valid").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    receivedAt: instant("received_at").notNull().defaultNow(),
  },
  (t) => [index("demo_inbox_received_idx").on(t.receivedAt)],
);
