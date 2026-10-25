import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { body, booking, type Club, createHarness, type Harness, seedClub } from "../support/harness";

let h: Harness;
let club: Club;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.reset();
  club = await seedClub(h);
});

// The harness clock starts at Monday 26 October 2026, 10:00 in Madrid (09:00Z).
const TUESDAY_1930 = "2026-10-27T19:30:00+01:00";

describe("POST /v1/bookings", () => {
  test("books a free slot and returns it with local times and a Location", async () => {
    const response = await h.request("/v1/bookings", {
      method: "POST",
      key: club.secretKey,
      json: booking(club, TUESDAY_1930),
    });
    expect(response.status).toBe(201);
    const created = await body(response);
    expect(created).toMatchObject({
      object: "booking",
      status: "confirmed",
      resourceId: club.courts[0],
      startsAt: "2026-10-27T19:30:00+01:00",
      endsAt: "2026-10-27T21:00:00+01:00",
      timezone: "Europe/Madrid",
      customer: { name: "Lucía Fernández", email: "lucia@example.com", phone: null },
    });
    expect(response.headers.get("location")).toBe(`/v1/bookings/${created.id}`);
  });

  test("the same slot cannot be booked twice", async () => {
    const first = await h.request("/v1/bookings", {
      method: "POST",
      key: club.secretKey,
      json: booking(club, TUESDAY_1930),
    });
    const second = await h.request("/v1/bookings", {
      method: "POST",
      key: club.secretKey,
      json: booking(club, TUESDAY_1930),
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.headers.get("content-type")).toBe("application/problem+json");
    expect(await body(second)).toMatchObject({ status: 409, title: "Slot unavailable" });
  });

  test("buffers keep the resource busy: a match must wait for the cleanup", async () => {
    await h.request("/v1/bookings", { method: "POST", key: club.secretKey, json: booking(club, TUESDAY_1930) });
    // 19:30 + 90 min = 21:00, plus 10 min cleanup: 21:00 overlaps, 21:10 would not.
    const tooEarly = await h.request("/v1/bookings", {
      method: "POST",
      key: club.secretKey,
      json: booking(club, "2026-10-27T21:00:00+01:00", { resourceId: club.courts[0] }),
    });
    expect(tooEarly.status).toBe(409);
    const staffAfterCleanup = await h.request("/v1/bookings", {
      method: "POST",
      key: club.secretKey,
      json: booking(club, "2026-10-27T21:10:00+01:00"),
    });
    expect(staffAfterCleanup.status).toBe(201);
  });

  test("without a resource, the first free one is taken", async () => {
    const first = await h.request("/v1/bookings", {
      method: "POST",
      key: club.secretKey,
      json: booking(club, TUESDAY_1930, { resourceId: undefined }),
    });
    const second = await h.request("/v1/bookings", {
      method: "POST",
      key: club.secretKey,
      json: booking(club, TUESDAY_1930, { resourceId: undefined }),
    });
    const third = await h.request("/v1/bookings", {
      method: "POST",
      key: club.secretKey,
      json: booking(club, TUESDAY_1930, { resourceId: undefined }),
    });
    expect([first.status, second.status, third.status]).toEqual([201, 201, 409]);
    const courts = [(await body(first)).resourceId, (await body(second)).resourceId];
    expect(new Set(courts)).toEqual(new Set(club.courts));
    expect(await body(third)).toMatchObject({ detail: "Every resource offering this service is busy at that time." });
  });

  test("customer rules apply to publishable keys only", async () => {
    const offGrid = booking(club, "2026-10-27T19:40:00+01:00");
    const widget = await h.request("/v1/bookings", { method: "POST", key: club.publishableKey, json: offGrid });
    expect(widget.status).toBe(422);
    expect(await body(widget)).toMatchObject({ reason: "off_grid" });
    const staff = await h.request("/v1/bookings", { method: "POST", key: club.secretKey, json: offGrid });
    expect(staff.status).toBe(201);

    const inTwentyMinutes = booking(club, "2026-10-26T10:20:00+01:00", { resourceId: club.courts[1] });
    const tooSoon = await h.request("/v1/bookings", {
      method: "POST",
      key: club.publishableKey,
      json: inTwentyMinutes,
    });
    expect(await body(tooSoon)).toMatchObject({ status: 422, reason: "off_grid" });
    const onGridTooSoon = booking(club, "2026-10-26T10:00:00+01:00", { resourceId: club.courts[1] });
    const rejected = await h.request("/v1/bookings", { method: "POST", key: club.publishableKey, json: onGridTooSoon });
    expect(await body(rejected)).toMatchObject({ status: 422, reason: "too_soon" });

    const inThreeWeeks = booking(club, "2026-11-16T19:30:00+01:00");
    const tooFar = await h.request("/v1/bookings", { method: "POST", key: club.publishableKey, json: inThreeWeeks });
    expect(await body(tooFar)).toMatchObject({ status: 422, reason: "too_far_ahead" });
  });

  test("validation errors list every bad field", async () => {
    const response = await h.request("/v1/bookings", {
      method: "POST",
      key: club.secretKey,
      json: { serviceId: "nope", startsAt: "tomorrow", customer: { name: "", email: "not-an-email" } },
    });
    expect(response.status).toBe(400);
    const problem = await body<{ errors: { path: string }[] }>(response);
    expect(problem.errors.map((error) => error.path).sort()).toEqual([
      "customer.email",
      "customer.name",
      "serviceId",
      "startsAt",
    ]);
  });

  test("bookings of another organization are invisible", async () => {
    const other = await seedClub(h, "Other");
    const created = await body(
      await h.request("/v1/bookings", { method: "POST", key: club.secretKey, json: booking(club, TUESDAY_1930) }),
    );
    const peek = await h.request(`/v1/bookings/${created.id}`, { key: other.secretKey });
    expect(peek.status).toBe(404);
    const crossBooking = await h.request("/v1/bookings", {
      method: "POST",
      key: other.secretKey,
      json: booking(club, TUESDAY_1930, { serviceId: club.matchServiceId }),
    });
    expect(crossBooking.status).toBe(404);
  });
});

describe("cancel and reschedule", () => {
  test("cancelling frees the slot", async () => {
    const created = await body(
      await h.request("/v1/bookings", { method: "POST", key: club.secretKey, json: booking(club, TUESDAY_1930) }),
    );
    const cancelled = await h.request(`/v1/bookings/${created.id}/cancel`, {
      method: "POST",
      key: club.secretKey,
      json: { reason: "Rain" },
    });
    expect(cancelled.status).toBe(200);
    expect(await body(cancelled)).toMatchObject({ status: "cancelled", cancellationReason: "Rain" });
    const again = await h.request(`/v1/bookings/${created.id}/cancel`, { method: "POST", key: club.secretKey });
    expect(again.status).toBe(409);
    const rebook = await h.request("/v1/bookings", {
      method: "POST",
      key: club.secretKey,
      json: booking(club, TUESDAY_1930),
    });
    expect(rebook.status).toBe(201);
  });

  test("rescheduling moves the booking, and cannot land on a taken slot", async () => {
    const first = await body(
      await h.request("/v1/bookings", { method: "POST", key: club.secretKey, json: booking(club, TUESDAY_1930) }),
    );
    await h.request("/v1/bookings", {
      method: "POST",
      key: club.secretKey,
      json: booking(club, "2026-10-27T17:30:00+01:00"),
    });
    const blocked = await h.request(`/v1/bookings/${first.id}/reschedule`, {
      method: "POST",
      key: club.secretKey,
      json: { startsAt: "2026-10-27T18:00:00+01:00" },
    });
    expect(blocked.status).toBe(409);
    const moved = await h.request(`/v1/bookings/${first.id}/reschedule`, {
      method: "POST",
      key: club.secretKey,
      json: { startsAt: "2026-10-28T19:30:00+01:00", resourceId: club.courts[1] },
    });
    expect(moved.status).toBe(200);
    expect(await body(moved)).toMatchObject({ startsAt: "2026-10-28T19:30:00+01:00", resourceId: club.courts[1] });
    // The old slot is free again.
    const reuse = await h.request("/v1/bookings", {
      method: "POST",
      key: club.secretKey,
      json: booking(club, TUESDAY_1930),
    });
    expect(reuse.status).toBe(201);
  });

  test("publishable keys cannot cancel", async () => {
    const created = await body(
      await h.request("/v1/bookings", { method: "POST", key: club.publishableKey, json: booking(club, TUESDAY_1930) }),
    );
    const response = await h.request(`/v1/bookings/${created.id}/cancel`, { method: "POST", key: club.publishableKey });
    expect(response.status).toBe(403);
    expect(await body(response)).toMatchObject({ requiredScope: "bookings:write" });
  });
});

describe("GET /v1/bookings", () => {
  test("pages through bookings in start order with a cursor", async () => {
    for (const day of ["27", "28", "29", "30", "31"]) {
      await h.request("/v1/bookings", {
        method: "POST",
        key: club.secretKey,
        json: booking(club, `2026-10-${day}T19:30:00+01:00`),
      });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `&cursor=${cursor}` : "";
      const page: { data: { startsAt: string }[]; nextCursor: string | null } = await body(
        await h.request(`/v1/bookings?limit=2${query}`, { key: club.secretKey }),
      );
      seen.push(...page.data.map((item) => item.startsAt.slice(0, 10)));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"]);
  });

  test("a tampered cursor is a validation error", async () => {
    const response = await h.request("/v1/bookings?cursor=bm9wZQ", { key: club.secretKey });
    expect(response.status).toBe(400);
  });
});

describe("time off", () => {
  test("blocks bookings, and cannot be added over existing ones", async () => {
    const add = await h.request(`/v1/resources/${club.courts[0]}/time-off`, {
      method: "POST",
      key: club.secretKey,
      json: { startsAt: "2026-10-27T18:00:00+01:00", endsAt: "2026-10-27T23:00:00+01:00", reason: "Resurfacing" },
    });
    expect(add.status).toBe(201);
    const blocked = await h.request("/v1/bookings", {
      method: "POST",
      key: club.secretKey,
      json: booking(club, TUESDAY_1930),
    });
    expect(await body(blocked)).toMatchObject({ status: 422, reason: "time_off" });

    const created = await body(
      await h.request("/v1/bookings", {
        method: "POST",
        key: club.secretKey,
        json: booking(club, "2026-10-28T19:30:00+01:00"),
      }),
    );
    const clash = await h.request(`/v1/resources/${club.courts[0]}/time-off`, {
      method: "POST",
      key: club.secretKey,
      json: { startsAt: "2026-10-28T19:00:00+01:00", endsAt: "2026-10-28T20:00:00+01:00" },
    });
    expect(clash.status).toBe(409);
    expect(await body(clash)).toMatchObject({ bookingIds: [created.id] });
  });
});
