import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { demoInbox, idempotencyKeys } from "../../src/db/schema";
import { POLICIES, secondsUntilAllowed } from "../../src/services/rate-limit";
import { sign } from "../../src/services/webhooks";
import { body, booking, type Club, createHarness, type Harness, seedClub } from "../support/harness";

let h: Harness;
let club: Club;

beforeAll(async () => {
  h = await createHarness({ demoEnabled: true });
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.reset();
  club = await seedClub(h);
});

describe("demo webhook receiver", () => {
  test("unsigned or malformed deliveries are refused and never shown", async () => {
    const forged = await h.request("/demo/webhooks", {
      method: "POST",
      json: { type: "booking.created", data: { startsAt: "x" } },
    });
    expect(forged.status).toBe(401);
    const nothing = await h.request("/demo/webhooks", { method: "POST", body: "null" });
    expect(nothing.status).toBe(401);
    expect(await h.db.select().from(demoInbox)).toHaveLength(0);
  });

  test("bodies are capped", async () => {
    const huge = await h.request("/demo/webhooks", { method: "POST", body: "x".repeat(70 * 1024) });
    expect(huge.status).toBe(422);
  });

  test("a delivery signed with someone else's secret is refused", async () => {
    const payload = JSON.stringify({ type: "booking.created", data: { id: "x" } });
    const now = Math.floor(h.deps.clock.now().epochMilliseconds / 1000);
    const signature = await sign("whsec_c29tZW9uZS1lbHNl", "msg_1", now, payload);
    const response = await h.request("/demo/webhooks", {
      method: "POST",
      body: payload,
      headers: { "webhook-id": "msg_1", "webhook-timestamp": String(now), "webhook-signature": signature },
    });
    expect(response.status).toBe(401);
    expect(await h.db.select().from(demoInbox)).toHaveLength(0);
  });
});

describe("event feed", () => {
  test("always hands back a cursor to resume from, and resuming returns only what's new", async () => {
    await h.request("/v1/bookings", {
      method: "POST",
      key: club.secretKey,
      json: booking(club, "2026-10-29T19:30:00+01:00"),
    });
    const first = await body<{ data: { type: string }[]; nextCursor: string | null; hasMore: boolean }>(
      await h.request("/v1/events", { key: club.secretKey }),
    );
    expect(first.data.map((event) => event.type)).toEqual(["booking.created"]);
    expect(first.hasMore).toBe(false);
    expect(first.nextCursor).not.toBeNull();

    const empty = await body<{ data: unknown[]; nextCursor: string }>(
      await h.request(`/v1/events?cursor=${first.nextCursor}`, { key: club.secretKey }),
    );
    expect(empty.data).toHaveLength(0);
    expect(empty.nextCursor).toBe(first.nextCursor as string);

    await h.request("/v1/bookings", {
      method: "POST",
      key: club.secretKey,
      json: booking(club, "2026-10-30T19:30:00+01:00"),
    });
    const next = await body<{ data: { type: string; data: { startsAt: string } }[] }>(
      await h.request(`/v1/events?cursor=${first.nextCursor}`, { key: club.secretKey }),
    );
    expect(next.data.map((event) => event.data.startsAt)).toEqual(["2026-10-30T19:30:00+01:00"]);
  });

  test("a malformed cursor is a validation error", async () => {
    const response = await h.request("/v1/events?cursor=not-a-cursor", { key: club.secretKey });
    expect(response.status).toBe(400);
  });
});

describe("idempotency hardening", () => {
  test("another API key can't replay a stored response, even with the same key and body", async () => {
    const request = (key: string) =>
      h.request("/v1/bookings", {
        method: "POST",
        key,
        json: booking(club, "2026-10-29T19:30:00+01:00"),
        headers: { "idempotency-key": "guessable-key-1" },
      });
    expect((await request(club.secretKey)).status).toBe(201);
    const other = await request(club.publishableKey);
    expect(other.status).toBe(422);
    expect(other.headers.get("idempotent-replayed")).toBeNull();
  });

  test("a claim abandoned mid-request can be taken over after its lease", async () => {
    await h.db.insert(idempotencyKeys).values({
      organizationId: club.organizationId,
      key: "crashed-request-1",
      fingerprint: "whatever",
      createdAt: new Date(h.deps.clock.now().epochMilliseconds - 61_000),
    });
    const retry = await h.request("/v1/bookings", {
      method: "POST",
      key: club.secretKey,
      json: booking(club, "2026-10-29T19:30:00+01:00"),
      headers: { "idempotency-key": "crashed-request-1" },
    });
    expect(retry.status).toBe(201);
  });
});

describe("smaller fixes", () => {
  test("Retry-After accounts for the previous window still counting", () => {
    const state = { count: 121, previousCount: 0, windowStartMs: 0 };
    expect(secondsUntilAllowed(POLICIES.publishableKey, state, 0)).toBe(61);
  });

  test("crafted cursors are validation errors, not server errors", async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const bookings = await h.request(`/v1/bookings?cursor=${encode({ s: "x", i: "y" })}`, { key: club.secretKey });
    expect(bookings.status).toBe(400);
    const resources = await h.request(`/v1/resources?cursor=${encode("-".repeat(36))}`, { key: club.secretKey });
    expect(resources.status).toBe(400);
  });

  test("letting the API pick the court still reports why a slot can't be booked", async () => {
    const response = await h.request("/v1/bookings", {
      method: "POST",
      key: club.publishableKey,
      json: booking(club, "2026-10-26T10:00:00+01:00", { resourceId: undefined }),
    });
    expect(response.status).toBe(422);
    expect(await body(response)).toMatchObject({ reason: "too_soon" });
  });

  test("the demo page's live feed is rate limited per visitor", async () => {
    let last = 200;
    for (let i = 0; i < 21; i++) {
      const response = await h.request("/demo/feed", { headers: { "x-forwarded-for": "203.0.113.50" } });
      last = response.status;
      await response.body?.cancel();
    }
    expect(last).toBe(429);
  });
});
