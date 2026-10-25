import { z } from "@hono/zod-openapi";
import { SCOPES } from "../context";
import { PROBLEM_DOCS } from "../lib/problem";
import { EVENT_TYPES } from "../services/events";

// ---------- shared ----------

export const ProblemSchema = z
  .object({
    type: z.string().openapi({ example: `${PROBLEM_DOCS}#slot-unavailable` }),
    title: z.string().openapi({ example: "Slot unavailable" }),
    status: z.number().int().openapi({ example: 409 }),
    detail: z.string().optional().openapi({ example: "Another booking holds this resource at that time." }),
    instance: z.string().optional().openapi({ example: "/v1/bookings" }),
    requestId: z.string().optional().openapi({ example: "0199c3e4-8f4e-7a51-9d6b-4f1c2b7e9a10" }),
    errors: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional()
      .openapi({ description: "Field errors, for validation problems." }),
  })
  .catchall(z.unknown())
  .openapi("Problem", { description: "RFC 9457 problem details. Every error has this shape." });

export const problemSpec = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

/** The errors every authenticated endpoint can return. */
export const commonErrors = {
  400: problemSpec("The request failed validation."),
  401: problemSpec("Missing, unknown or revoked API key."),
  403: problemSpec("The API key lacks a required scope."),
  429: problemSpec("Rate limit exceeded; see Retry-After."),
} as const;

const Id = (example: string) => z.uuid().openapi({ example });
const RESOURCE_ID = "0199c3e4-1a2b-7c3d-8e4f-5a6b7c8d9e01";
const SERVICE_ID = "0199c3e4-2b3c-7d4e-9f5a-6b7c8d9e0f12";
const BOOKING_ID = "0199c3f1-7d8e-7f9a-8b0c-1d2e3f4a5b6c";

export const Instant = z.iso
  .datetime({ offset: true })
  .openapi({ example: "2026-10-29T19:30:00+01:00", description: "RFC 3339 date-time with offset or Z." });
const LocalDate = (example: string) => z.iso.date().openapi({ example, description: "Local date, YYYY-MM-DD." });

export const ListMeta = {
  object: z.literal("list"),
  nextCursor: z
    .string()
    .nullable()
    .openapi({ description: "Pass as `cursor` to get the next page; null on the last page.", example: null }),
};

export const PageQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(25).openapi({ example: 25 }),
  cursor: z.string().max(200).optional().openapi({ description: "Opaque cursor from a previous page." }),
};

export const IdempotencyHeader = z.object({
  "idempotency-key": z.string().min(8).max(200).optional().openapi({
    description: "Makes the request safe to retry: the same key returns the stored result for 24 h.",
    example: "b5a3f0c2-checkout-7731",
  }),
});

// ---------- resources ----------

const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");
const ClockOrMidnight = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, "use HH:MM, or 24:00 for midnight");

export const OpeningHoursSchema = z
  .object({
    weekday: z
      .number()
      .int()
      .min(1)
      .max(7)
      .openapi({ description: "ISO weekday: 1 = Monday, 7 = Sunday.", example: 4 }),
    opensAt: Clock.openapi({ example: "08:00" }),
    closesAt: ClockOrMidnight.openapi({ example: "23:00" }),
  })
  .openapi("OpeningHours");

const Metadata = z
  .record(z.string().max(40), z.string().max(500))
  .refine((value) => Object.keys(value).length <= 20, "at most 20 keys")
  .openapi({ example: { surface: "glass" } });

export const ResourceSchema = z
  .object({
    id: Id(RESOURCE_ID),
    object: z.literal("resource"),
    name: z.string().openapi({ example: "Court 1" }),
    timezone: z.string().openapi({ example: "Europe/Madrid" }),
    active: z.boolean(),
    metadata: Metadata,
    openingHours: z.array(OpeningHoursSchema),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("Resource", { description: "Something that can be booked: a court, a room, a person." });

export const ResourceInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120).openapi({ example: "Court 1" }),
    timezone: z
      .string()
      .optional()
      .openapi({ example: "Europe/Madrid", description: "IANA zone; defaults to the organization's." }),
    active: z.boolean().optional(),
    metadata: Metadata.optional(),
    openingHours: z.array(OpeningHoursSchema).max(50).optional(),
  })
  .openapi("ResourceInput");

export const ResourcePatchSchema = ResourceInputSchema.partial().openapi("ResourcePatch");

export const TimeOffSchema = z
  .object({
    id: z.uuid(),
    object: z.literal("time_off"),
    resourceId: Id(RESOURCE_ID),
    startsAt: Instant,
    endsAt: Instant,
    reason: z.string().nullable().openapi({ example: "Resurfacing" }),
    createdAt: z.iso.datetime(),
  })
  .openapi("TimeOff");

export const TimeOffInputSchema = z
  .object({
    startsAt: Instant,
    endsAt: Instant.openapi({ example: "2026-10-29T23:00:00+01:00" }),
    reason: z.string().max(200).optional().openapi({ example: "Resurfacing" }),
  })
  .openapi("TimeOffInput");

// ---------- services ----------

const Price = z
  .object({
    amountCents: z.number().int().min(0).openapi({ example: 2800 }),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .openapi({ example: "EUR" }),
  })
  .openapi("Price");

export const ServiceSchema = z
  .object({
    id: Id(SERVICE_ID),
    object: z.literal("service"),
    name: z.string().openapi({ example: "Match · 90 min" }),
    durationMinutes: z.number().int().openapi({ example: 90 }),
    bufferBeforeMinutes: z.number().int().openapi({ example: 0 }),
    bufferAfterMinutes: z.number().int().openapi({ example: 10, description: "Kept free after each booking." }),
    slotIntervalMinutes: z.number().int().openapi({ example: 30 }),
    minNoticeMinutes: z.number().int().openapi({ example: 60 }),
    maxAdvanceDays: z.number().int().openapi({ example: 14 }),
    price: Price.nullable(),
    active: z.boolean(),
    resourceIds: z.array(z.uuid()),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("Service", { description: "What gets booked, and the rules for booking it." });

export const ServiceInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120).openapi({ example: "Match · 90 min" }),
    durationMinutes: z.number().int().min(5).max(720).openapi({ example: 90 }),
    bufferBeforeMinutes: z.number().int().min(0).max(240).optional(),
    bufferAfterMinutes: z.number().int().min(0).max(240).optional().openapi({ example: 10 }),
    slotIntervalMinutes: z.number().int().min(5).max(240).optional().openapi({ example: 30 }),
    minNoticeMinutes: z.number().int().min(0).max(43_200).optional().openapi({ example: 60 }),
    maxAdvanceDays: z.number().int().min(1).max(730).optional().openapi({ example: 14 }),
    price: Price.nullable().optional(),
    active: z.boolean().optional(),
    resourceIds: z
      .array(z.uuid())
      .max(100)
      .openapi({ example: [RESOURCE_ID] }),
  })
  .openapi("ServiceInput");

export const ServicePatchSchema = ServiceInputSchema.partial().openapi("ServicePatch");

// ---------- availability ----------

export const SlotSchema = z
  .object({
    resourceId: Id(RESOURCE_ID),
    start: Instant,
    end: Instant.openapi({ example: "2026-10-29T21:00:00+01:00" }),
  })
  .openapi("Slot");

export const AvailabilitySchema = z
  .object({
    object: z.literal("availability"),
    serviceId: Id(SERVICE_ID),
    from: LocalDate("2026-10-29"),
    to: LocalDate("2026-10-29"),
    slots: z.array(SlotSchema),
  })
  .openapi("Availability", {
    description: "Start times are in each resource's zone, with the offset, so DST repeats stay unambiguous.",
  });

export const AvailabilityQuerySchema = z.object({
  serviceId: Id(SERVICE_ID),
  resourceId: z.uuid().optional().openapi({ description: "Only this resource; default: all that offer the service." }),
  from: LocalDate("2026-10-29"),
  to: LocalDate("2026-10-29").optional().openapi({ description: "Inclusive; defaults to `from`. At most 31 days." }),
});

// ---------- bookings ----------

const Customer = z
  .object({
    name: z.string().trim().min(1).max(120).openapi({ example: "Lucía Fernández" }),
    email: z.email().max(254).openapi({ example: "lucia@example.com" }),
    phone: z
      .string()
      .regex(/^\+?[0-9 ()-]{6,20}$/)
      .nullable()
      .optional()
      .openapi({ example: "+34 600 123 456" }),
  })
  .openapi("Customer");

export const BookingSchema = z
  .object({
    id: Id(BOOKING_ID),
    object: z.literal("booking"),
    resourceId: Id(RESOURCE_ID),
    serviceId: Id(SERVICE_ID),
    status: z.enum(["confirmed", "cancelled"]),
    startsAt: Instant,
    endsAt: Instant.openapi({ example: "2026-10-29T21:00:00+01:00" }),
    timezone: z.string().openapi({ example: "Europe/Madrid" }),
    customer: Customer,
    notes: z.string().nullable(),
    metadata: Metadata,
    cancelledAt: z.iso.datetime().nullable(),
    cancellationReason: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("Booking");

export const BookingInputSchema = z
  .object({
    serviceId: Id(SERVICE_ID),
    resourceId: z
      .uuid()
      .optional()
      .openapi({ example: RESOURCE_ID, description: "Omit to take the first free resource offering the service." }),
    startsAt: Instant,
    customer: Customer,
    notes: z.string().max(1000).nullable().optional(),
    metadata: Metadata.optional(),
  })
  .openapi("BookingInput");

export const CancelInputSchema = z
  .object({ reason: z.string().max(300).optional().openapi({ example: "Rain" }) })
  .openapi("CancelInput");

export const RescheduleInputSchema = z
  .object({
    startsAt: Instant,
    resourceId: z.uuid().optional().openapi({ description: "Move to another resource as well." }),
  })
  .openapi("RescheduleInput");

export const BookingListQuerySchema = z.object({
  ...PageQuery,
  resourceId: z.uuid().optional(),
  status: z.enum(["confirmed", "cancelled"]).optional(),
  from: Instant.optional().openapi({ description: "Bookings starting at or after this instant." }),
  to: Instant.optional().openapi({ description: "Bookings starting before this instant." }),
});

// ---------- webhooks & events ----------

const EventTypeOrAll = z.enum([...EVENT_TYPES, "*"]);

export const WebhookEndpointSchema = z
  .object({
    id: z.uuid(),
    object: z.literal("webhook_endpoint"),
    url: z.url().openapi({ example: "https://example.com/hooks/slotlock" }),
    description: z.string().nullable(),
    events: z.array(EventTypeOrAll).openapi({ example: ["booking.created", "booking.cancelled"] }),
    active: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .openapi("WebhookEndpoint");

export const WebhookEndpointCreatedSchema = WebhookEndpointSchema.extend({
  secret: z.string().openapi({
    example: "whsec_EXAMPLE0nlyNotARealSecret0000000000=",
    description: "Signing secret. Shown once: store it to verify the webhook-signature header.",
  }),
}).openapi("WebhookEndpointCreated");

export const WebhookEndpointInputSchema = z
  .object({
    url: z.url().max(2000).openapi({ example: "https://example.com/hooks/slotlock" }),
    events: z
      .array(EventTypeOrAll)
      .min(1)
      .max(10)
      .openapi({ example: ["booking.created", "booking.cancelled"] }),
    description: z.string().max(200).optional(),
  })
  .openapi("WebhookEndpointInput");

export const DeliverySchema = z
  .object({
    id: z.uuid(),
    object: z.literal("webhook_delivery"),
    eventId: z.uuid(),
    eventType: z.string().openapi({ example: "booking.created" }),
    status: z.enum(["pending", "succeeded", "failed"]),
    attempts: z.number().int(),
    nextAttemptAt: z.iso.datetime().nullable(),
    lastAttemptAt: z.iso.datetime().nullable(),
    lastResponseStatus: z.number().int().nullable().openapi({ example: 200 }),
    lastError: z.string().nullable(),
    lastDurationMs: z.number().int().nullable().openapi({ example: 143 }),
    createdAt: z.iso.datetime(),
  })
  .openapi("WebhookDelivery");

export const EventSchema = z
  .object({
    id: z.uuid(),
    object: z.literal("event"),
    type: z.string().openapi({ example: "booking.created" }),
    data: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime(),
  })
  .openapi("Event");

export const OrganizationSchema = z
  .object({
    id: z.uuid(),
    object: z.literal("organization"),
    name: z.string().openapi({ example: "Demo Padel Club" }),
    slug: z.string().openapi({ example: "demo-padel-club" }),
    timezone: z.string().openapi({ example: "Europe/Madrid" }),
    apiKey: z.object({
      kind: z.enum(["secret", "publishable"]),
      scopes: z.array(z.enum(SCOPES)),
    }),
  })
  .openapi("Organization");

export const IdParam = (name: string, example: string) =>
  z.object({ id: z.uuid().openapi({ param: { name: "id", in: "path" }, example, description: `${name} id.` }) });

export const EXAMPLE_IDS = { RESOURCE_ID, SERVICE_ID, BOOKING_ID };
