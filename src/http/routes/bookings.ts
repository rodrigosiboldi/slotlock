import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { streamSSE } from "hono/streaming";
import type { AppEnv, Deps } from "../../context";
import { serviceResources } from "../../db/schema";
import { problems } from "../../lib/problem";
import { findAvailability, loadActiveService } from "../../services/availability";
import { cancelBooking, createBooking, getBooking, listBookings, rescheduleBooking } from "../../services/bookings";
import { decodeFeedCursor, encodeFeedCursor, eventsAfter, latestCursor } from "../../services/events";
import { dispatchDue } from "../../services/webhooks";
import { requireScope } from "../middleware";
import {
  AvailabilityQuerySchema,
  AvailabilitySchema,
  BookingInputSchema,
  BookingListQuerySchema,
  BookingSchema,
  CancelInputSchema,
  commonErrors,
  EXAMPLE_IDS,
  IdempotencyHeader,
  IdParam,
  ListMeta,
  problemSpec,
  RescheduleInputSchema,
} from "../schemas";
import { decodeCursor, encodeCursor, isUuid, serializeBooking, serializeSlot } from "../serialize";

const security = [{ ApiKey: [] }];
const json = <T>(schema: T) => ({ "application/json": { schema } });

/** How long one availability stream stays open; clients reconnect (SSE does it by itself). */
const STREAM_SECONDS = 240;
const STREAM_POLL_MS = 1_000;
const STREAM_HEARTBEAT_MS = 15_000;

interface BookingCursor {
  s: string;
  i: string;
}
const isBookingCursor = (value: unknown): value is BookingCursor =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as BookingCursor).s === "string" &&
  !Number.isNaN(Date.parse((value as BookingCursor).s)) &&
  isUuid((value as BookingCursor).i);

export function registerBookingRoutes(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  const afterWrite = () => deps.background(dispatchDue(deps));

  // ---------- availability ----------

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/availability",
      tags: ["Availability"],
      summary: "Find open slots",
      description:
        "Start times at which the service can be booked, across every resource that offers it. Dates are " +
        "read in each resource's time zone; times come back with their offset, so the hour that repeats " +
        "when clocks go back appears twice, with two different offsets.",
      security,
      middleware: [requireScope("availability:read")] as const,
      request: { query: AvailabilityQuerySchema },
      responses: {
        200: { description: "Open slots, earliest first.", content: json(AvailabilitySchema) },
        404: problemSpec("No such service."),
        422: problemSpec("Range too long or reversed, or the resource does not offer the service."),
        ...commonErrors,
      },
    }),
    async (c) => {
      const query = c.req.valid("query");
      const from = Temporal.PlainDate.from(query.from);
      const to = Temporal.PlainDate.from(query.to ?? query.from);
      const slots = await findAvailability(
        deps.db,
        c.var.auth.organizationId,
        { serviceId: query.serviceId, resourceId: query.resourceId, from, to },
        deps.clock.now(),
      );
      c.header("cache-control", "no-store");
      return c.json(
        {
          object: "availability" as const,
          serviceId: query.serviceId,
          from: from.toString(),
          to: to.toString(),
          slots: slots.map(serializeSlot),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/availability/stream",
      tags: ["Availability"],
      summary: "Watch availability change",
      description:
        "Server-Sent Events. Emits `availability.changed` whenever a booking is created, cancelled or moved on a " +
        "resource offering the service; fetch `/v1/availability` again when it arrives. The stream closes after " +
        `${STREAM_SECONDS} s with a retry hint; reconnecting is automatic for EventSource clients.`,
      security,
      middleware: [requireScope("availability:read")] as const,
      request: { query: z.object({ serviceId: AvailabilityQuerySchema.shape.serviceId }) },
      responses: {
        200: {
          description: "An event stream.",
          content: {
            "text/event-stream": {
              schema: z.string().openapi({ example: 'event: availability.changed\ndata: {"resourceIds":["…"]}\n\n' }),
            },
          },
        },
        404: problemSpec("No such service."),
        ...commonErrors,
      },
    }),
    async (c) => {
      const { serviceId } = c.req.valid("query");
      const organizationId = c.var.auth.organizationId;
      await loadActiveService(deps.db, organizationId, serviceId);
      const links = await deps.db
        .select({ resourceId: serviceResources.resourceId })
        .from(serviceResources)
        .where(eq(serviceResources.serviceId, serviceId));
      const watched = new Set(links.map((link) => link.resourceId));
      c.header("cache-control", "no-store");
      c.header("x-accel-buffering", "no");

      return streamSSE(c, async (stream) => {
        let open = true;
        stream.onAbort(() => {
          open = false;
        });
        // Changes are read from the outbox (events table) in commit-safe order, so nothing on the
        // booking path has to know that anyone is listening. A reconnecting client resumes from
        // Last-Event-ID; a new one starts from "now".
        let cursor = decodeFeedCursor(c.req.header("last-event-id")) ?? (await latestCursor(deps.db, organizationId));

        await stream.writeSSE({ event: "ready", data: JSON.stringify({ serviceId }), retry: 1000 });
        const deadline = Date.now() + STREAM_SECONDS * 1000;
        let lastWrite = Date.now();
        while (open && Date.now() < deadline) {
          const fresh = await eventsAfter(deps.db, organizationId, cursor, { limit: 100, typePrefix: "booking." });
          const touched = new Set<string>();
          for (const event of fresh) {
            cursor = event.cursor;
            const data = event.data as { resourceId?: string; previous?: { resourceId?: string } };
            for (const id of [data.resourceId, data.previous?.resourceId]) if (id && watched.has(id)) touched.add(id);
          }
          if (touched.size > 0) {
            await stream.writeSSE({
              id: cursor ? encodeFeedCursor(cursor) : "",
              event: "availability.changed",
              data: JSON.stringify({ resourceIds: [...touched] }),
            });
            lastWrite = Date.now();
          } else if (Date.now() - lastWrite > STREAM_HEARTBEAT_MS) {
            await stream.write(": heartbeat\n\n");
            lastWrite = Date.now();
          }
          await stream.sleep(STREAM_POLL_MS);
        }
      });
    },
  );

  // ---------- bookings ----------

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/bookings",
      tags: ["Bookings"],
      summary: "Book a slot",
      description:
        "Two requests for the same slot cannot both succeed: Postgres enforces it with an exclusion constraint, " +
        "whatever server or connection each lands on. The loser gets `409 slot-unavailable`. Send an " +
        "`Idempotency-Key` to make retries safe. With a publishable key, customer rules apply (slot grid, " +
        "minimum notice, booking window); staff with a secret key may book any time the resource is open.",
      security,
      middleware: [requireScope("bookings:create")] as const,
      request: { headers: IdempotencyHeader, body: { content: json(BookingInputSchema), required: true } },
      responses: {
        201: { description: "Booked.", content: json(BookingSchema) },
        404: problemSpec("No such service or resource."),
        409: problemSpec("The slot is taken (`slot-unavailable`), or the idempotency key is in use."),
        422: problemSpec("The slot is not bookable (closed, off the grid, too soon, too far ahead, time off)."),
        ...commonErrors,
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const race = c.var.race;
      if (race && input.resourceId !== race.resourceId) {
        throw problems.unprocessable(
          "invalid-race-ticket",
          "Invalid race ticket",
          "A race ticket only books its race court.",
        );
      }
      const booking = await createBooking(deps, c.var.auth, {
        ...input,
        startsAt: Temporal.Instant.from(input.startsAt),
      });
      afterWrite();
      return c.json(serializeBooking(booking), 201, { location: `/v1/bookings/${booking.id}` });
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/bookings",
      tags: ["Bookings"],
      summary: "List bookings",
      description: "Ordered by start time. Cursor pagination stays stable while bookings are being added.",
      security,
      middleware: [requireScope("bookings:read")] as const,
      request: { query: BookingListQuerySchema },
      responses: {
        200: {
          description: "A page of bookings.",
          content: json(z.object({ ...ListMeta, data: z.array(BookingSchema) }).openapi("BookingList")),
        },
        ...commonErrors,
      },
    }),
    async (c) => {
      const query = c.req.valid("query");
      const after = decodeCursor(query.cursor, isBookingCursor);
      const rows = await listBookings(
        deps.db,
        c.var.auth.organizationId,
        {
          resourceId: query.resourceId,
          status: query.status,
          from: query.from ? new Date(query.from) : undefined,
          to: query.to ? new Date(query.to) : undefined,
        },
        { limit: query.limit + 1, after: after ? { startsAt: new Date(after.s), id: after.i } : undefined },
      );
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return c.json(
        {
          object: "list" as const,
          data: page.map(serializeBooking),
          nextCursor:
            rows.length > query.limit && last ? encodeCursor({ s: last.startsAt.toISOString(), i: last.id }) : null,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/bookings/{id}",
      tags: ["Bookings"],
      summary: "Get a booking",
      security,
      middleware: [requireScope("bookings:read")] as const,
      request: { params: IdParam("Booking", EXAMPLE_IDS.BOOKING_ID) },
      responses: {
        200: { description: "The booking.", content: json(BookingSchema) },
        404: problemSpec("No such booking."),
        ...commonErrors,
      },
    }),
    async (c) => {
      const booking = await getBooking(deps.db, c.var.auth.organizationId, c.req.valid("param").id);
      if (!booking) throw problems.notFound("Booking");
      return c.json(serializeBooking(booking), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/bookings/{id}/cancel",
      tags: ["Bookings"],
      summary: "Cancel a booking",
      description: "Frees the slot immediately and emits `booking.cancelled`.",
      security,
      middleware: [requireScope("bookings:write")] as const,
      request: {
        params: IdParam("Booking", EXAMPLE_IDS.BOOKING_ID),
        headers: IdempotencyHeader,
        body: { content: json(CancelInputSchema), required: false },
      },
      responses: {
        200: { description: "The cancelled booking.", content: json(BookingSchema) },
        404: problemSpec("No such booking."),
        409: problemSpec("Already cancelled."),
        ...commonErrors,
      },
    }),
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const parsed = CancelInputSchema.safeParse(body ?? {});
      const reason = parsed.success ? (parsed.data.reason ?? null) : null;
      const booking = await cancelBooking(deps, c.var.auth, c.req.valid("param").id, reason);
      afterWrite();
      return c.json(serializeBooking(booking), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/bookings/{id}/reschedule",
      tags: ["Bookings"],
      summary: "Reschedule a booking",
      description: "Moves the booking atomically: the new slot is taken and the old one freed in one transaction.",
      security,
      middleware: [requireScope("bookings:write")] as const,
      request: {
        params: IdParam("Booking", EXAMPLE_IDS.BOOKING_ID),
        headers: IdempotencyHeader,
        body: { content: json(RescheduleInputSchema), required: true },
      },
      responses: {
        200: { description: "The moved booking.", content: json(BookingSchema) },
        404: problemSpec("No such booking or resource."),
        409: problemSpec("The new slot is taken, or the booking is cancelled."),
        422: problemSpec("The new slot is not bookable."),
        ...commonErrors,
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const booking = await rescheduleBooking(deps, c.var.auth, c.req.valid("param").id, {
        startsAt: Temporal.Instant.from(input.startsAt),
        resourceId: input.resourceId,
      });
      afterWrite();
      return c.json(serializeBooking(booking), 200);
    },
  );
}
