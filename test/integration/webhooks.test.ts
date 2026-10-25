import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { webhookDeliveries } from "../../src/db/schema";
import { dispatchDue, isPrivateAddress, verify } from "../../src/services/webhooks";
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

async function subscribe(url = "http://localhost:4000/hooks") {
  const response = await h.request("/v1/webhook-endpoints", {
    method: "POST",
    key: club.secretKey,
    json: { url, events: ["booking.created", "booking.cancelled"] },
  });
  expect(response.status).toBe(201);
  return body<{ id: string; secret: string }>(response);
}

describe("webhooks", () => {
  test("a booking is delivered, signed per Standard Webhooks", async () => {
    const endpoint = await subscribe();
    expect(endpoint.secret).toStartWith("whsec_");
    const created = await body(
      await h.request("/v1/bookings", {
        method: "POST",
        key: club.secretKey,
        json: booking(club, "2026-10-29T19:30:00+01:00"),
      }),
    );
    await h.settle();

    expect(h.outbound).toHaveLength(1);
    const call = h.outbound[0];
    const headers = new Headers(call?.init.headers);
    const payload = String(call?.init.body);
    expect(JSON.parse(payload)).toMatchObject({ type: "booking.created", data: { id: created.id, object: "booking" } });
    const valid = await verify(
      endpoint.secret,
      {
        id: headers.get("webhook-id"),
        timestamp: headers.get("webhook-timestamp"),
        signature: headers.get("webhook-signature"),
      },
      payload,
      Math.floor(h.deps.clock.now().epochMilliseconds / 1000),
    );
    expect(valid).toBe(true);
    expect(
      await verify(
        endpoint.secret,
        {
          id: headers.get("webhook-id"),
          timestamp: headers.get("webhook-timestamp"),
          signature: headers.get("webhook-signature"),
        },
        `${payload} `,
        0,
      ),
    ).toBe(false);

    const log = await body<{ data: { status: string; attempts: number }[] }>(
      await h.request(`/v1/webhook-endpoints/${endpoint.id}/deliveries`, { key: club.secretKey }),
    );
    expect(log.data[0]).toMatchObject({ status: "succeeded", attempts: 1 });
  });

  test("failures are retried with backoff, then given up on", async () => {
    await subscribe();
    h.respondWith(503);
    await h.request("/v1/bookings", {
      method: "POST",
      key: club.secretKey,
      json: booking(club, "2026-10-29T19:30:00+01:00"),
    });
    await h.settle();
    let [delivery] = await h.db.select().from(webhookDeliveries);
    expect(delivery).toMatchObject({ status: "pending", attempts: 1, lastResponseStatus: 503 });

    // Not due yet: nothing is sent.
    expect((await dispatchDue(h.deps)).attempted).toBe(0);
    for (const minutes of [1, 2, 10, 60, 360]) {
      h.clock.advance(minutes);
      expect((await dispatchDue(h.deps)).attempted).toBe(1);
    }
    [delivery] = await h.db.select().from(webhookDeliveries);
    expect(delivery).toMatchObject({ status: "failed", attempts: 6 });
    expect(h.outbound).toHaveLength(6);
  });

  test("a rolled-back booking never produces an event", async () => {
    await subscribe();
    await h.request("/v1/bookings", {
      method: "POST",
      key: club.secretKey,
      json: booking(club, "2026-10-29T19:30:00+01:00"),
    });
    await h.request("/v1/bookings", {
      method: "POST",
      key: club.secretKey,
      json: booking(club, "2026-10-29T19:30:00+01:00"),
    });
    await h.settle();
    const events = await body<{ data: { type: string }[] }>(await h.request("/v1/events", { key: club.secretKey }));
    expect(events.data.map((event) => event.type)).toEqual(["booking.created"]);
    expect(h.outbound).toHaveLength(1);
  });

  test("in production, private and plain-http targets are refused", async () => {
    const production = await createHarness({ env: "production" });
    try {
      const prodClub = await seedClub(production);
      for (const url of [
        "http://example.com/hook",
        "https://10.0.0.7/hook",
        "https://localhost/hook",
        "https://[::1]/hook",
      ]) {
        const response = await production.request("/v1/webhook-endpoints", {
          method: "POST",
          key: prodClub.secretKey,
          json: { url, events: ["*"] },
        });
        expect(response.status).toBe(422);
      }
    } finally {
      await production.close();
    }
  });

  test("private address detection", () => {
    for (const address of [
      "10.1.2.3",
      "127.0.0.1",
      "169.254.169.254",
      "172.20.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "::1",
      "fd00::1",
      "::ffff:10.0.0.1",
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    for (const address of ["8.8.8.8", "76.76.21.21", "2606:4700::1111"]) expect(isPrivateAddress(address)).toBe(false);
  });
});
