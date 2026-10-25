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

describe("resources and services", () => {
  test("creates a resource with opening hours in its own zone", async () => {
    const response = await h.request("/v1/resources", {
      method: "POST",
      key: club.secretKey,
      json: {
        name: "Court Lisbon",
        timezone: "Europe/Lisbon",
        openingHours: [
          { weekday: 1, opensAt: "18:00", closesAt: "24:00" },
          { weekday: 2, opensAt: "00:00", closesAt: "02:00" },
        ],
        metadata: { surface: "clay" },
      },
    });
    expect(response.status).toBe(201);
    expect(await body(response)).toMatchObject({
      object: "resource",
      timezone: "Europe/Lisbon",
      openingHours: [
        { weekday: 1, opensAt: "18:00", closesAt: "24:00" },
        { weekday: 2, opensAt: "00:00", closesAt: "02:00" },
      ],
    });
  });

  test("rejects unknown zones and overlapping hours", async () => {
    const zone = await h.request("/v1/resources", {
      method: "POST",
      key: club.secretKey,
      json: { name: "X", timezone: "Mars/Olympus_Mons" },
    });
    expect(zone.status).toBe(400);
    const overlap = await h.request("/v1/resources", {
      method: "POST",
      key: club.secretKey,
      json: {
        name: "X",
        openingHours: [
          { weekday: 3, opensAt: "08:00", closesAt: "14:00" },
          { weekday: 3, opensAt: "13:00", closesAt: "20:00" },
        ],
      },
    });
    expect(overlap.status).toBe(400);
    expect(JSON.stringify(await body(overlap))).toContain("overlap on weekday 3");
  });

  test("services can only use the organization's own resources", async () => {
    const other = await seedClub(h, "Other");
    const response = await h.request("/v1/services", {
      method: "POST",
      key: club.secretKey,
      json: { name: "Stolen", durationMinutes: 60, resourceIds: [other.courts[0]] },
    });
    expect(response.status).toBe(422);
    expect(await body(response)).toMatchObject({ resourceIds: [other.courts[0]] });
  });

  test("lists resources page by page", async () => {
    for (const name of ["Court 3", "Court 4", "Court 5"]) {
      await h.request("/v1/resources", { method: "POST", key: club.secretKey, json: { name } });
    }
    const first = await body<{ data: { name: string }[]; nextCursor: string }>(
      await h.request("/v1/resources?limit=3", { key: club.secretKey }),
    );
    const second = await body<{ data: { name: string }[]; nextCursor: null }>(
      await h.request(`/v1/resources?limit=3&cursor=${first.nextCursor}`, { key: club.secretKey }),
    );
    expect([...first.data, ...second.data].map((resource) => resource.name)).toEqual([
      "Court 1",
      "Court 2",
      "Court 3",
      "Court 4",
      "Court 5",
    ]);
    expect(second.nextCursor).toBeNull();
  });
});

describe("GET /v1/availability", () => {
  const query = (club: Club, extra = "") => `/v1/availability?serviceId=${club.matchServiceId}&from=2026-10-27${extra}`;

  test("lists slots per court with offsets, and drops booked ones", async () => {
    const before = await body<{ slots: { resourceId: string; start: string }[] }>(
      await h.request(query(club, `&resourceId=${club.courts[0]}`), { key: club.publishableKey }),
    );
    // 08:00 to 21:30 every 30 minutes (a 90-minute match must end by 23:00).
    expect(before.slots).toHaveLength(28);
    expect(before.slots[0]?.start).toBe("2026-10-27T08:00:00+01:00");
    expect(before.slots.at(-1)?.start).toBe("2026-10-27T21:30:00+01:00");

    await h.request("/v1/bookings", {
      method: "POST",
      key: club.secretKey,
      json: booking(club, "2026-10-27T19:30:00+01:00"),
    });
    const after = await body<{ slots: { start: string }[] }>(
      await h.request(query(club, `&resourceId=${club.courts[0]}`), { key: club.publishableKey }),
    );
    const starts = after.slots.map((slot) => slot.start.slice(11, 16));
    // Both buffers count: an 18:00 match would end at 19:30 but its own cleanup runs to 19:40, into
    // the 19:30 booking; a 21:00 match would start inside that booking's 21:00–21:10 cleanup.
    for (const taken of ["18:00", "18:30", "19:00", "19:30", "20:00", "20:30", "21:00"])
      expect(starts).not.toContain(taken);
    expect(starts).toContain("17:30");
    expect(starts).toContain("21:30");
  });

  test("asking without a resource covers every court", async () => {
    const all = await body<{ slots: { resourceId: string }[] }>(
      await h.request(query(club), { key: club.publishableKey }),
    );
    expect(new Set(all.slots.map((slot) => slot.resourceId))).toEqual(new Set(club.courts));
    expect(all.slots).toHaveLength(56);
  });

  test("ranges longer than 31 days are refused", async () => {
    const response = await h.request(`${query(club)}&to=2026-12-31`, { key: club.publishableKey });
    expect(response.status).toBe(422);
  });
});

describe("system", () => {
  test("health, readiness and the OpenAPI document", async () => {
    expect(await body(await h.request("/healthz"))).toMatchObject({ status: "ok", version: "test" });
    expect(await body(await h.request("/readyz"))).toMatchObject({
      status: "ready",
      database: { noOverlapConstraint: true },
    });

    const spec = await body<{
      openapi: string;
      paths: Record<string, unknown>;
      components: { securitySchemes: object };
    }>(await h.request("/openapi.json"));
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(["/v1/bookings", "/v1/availability", "/v1/availability/stream", "/v1/webhook-endpoints"]),
    );
    expect(spec.components.securitySchemes).toHaveProperty("ApiKey");

    const docs = await h.request("/docs");
    expect(docs.status).toBe(200);
    expect(await docs.text()).toContain("<html");
  });

  test("metrics need the token", async () => {
    expect((await h.request("/metrics")).status).toBe(404);
    const metrics = await h.request("/metrics", { headers: { authorization: "Bearer metrics-token-0123456789" } });
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain("http_requests_total");
  });

  test("unknown routes are 404 problems", async () => {
    const response = await h.request("/nope");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
  });

  test("the daily cron needs its secret and expires stale state", async () => {
    expect((await h.request("/internal/cron/daily")).status).toBe(401);
    const run = await h.request("/internal/cron/daily", {
      headers: { authorization: "Bearer cron-secret-0123456789" },
    });
    expect(run.status).toBe(200);
    expect(await body(run)).toMatchObject({ ok: true });
  });
});
