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

const SLOT = "2026-10-29T19:30:00+01:00";

describe("concurrency", () => {
  test("of 100 simultaneous requests for one slot, exactly one wins", async () => {
    const attempts = Array.from({ length: 100 }, (_, i) =>
      h.request("/v1/bookings", {
        method: "POST",
        key: club.secretKey,
        json: booking(club, SLOT, { customer: { name: `Player ${i}`, email: `p${i}@example.com` } }),
      }),
    );
    const statuses = (await Promise.all(attempts)).map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(99);

    const list = await body<{ data: unknown[] }>(
      await h.request("/v1/bookings?status=confirmed", { key: club.secretKey }),
    );
    expect(list.data).toHaveLength(1);
  });

  test("overlapping (not identical) slots race too: one 18:30 and one 19:30, 90 minutes each", async () => {
    const [a, b] = await Promise.all([
      h.request("/v1/bookings", {
        method: "POST",
        key: club.secretKey,
        json: booking(club, "2026-10-29T18:30:00+01:00"),
      }),
      h.request("/v1/bookings", { method: "POST", key: club.secretKey, json: booking(club, SLOT) }),
    ]);
    expect([a?.status, b?.status].sort()).toEqual([201, 409]);
  });
});

describe("idempotency", () => {
  const send = (key: string, json: unknown) =>
    h.request("/v1/bookings", { method: "POST", key: club.secretKey, json, headers: { "idempotency-key": key } });

  test("a retried request returns the original response instead of acting twice", async () => {
    const first = await send("retry-key-0001", booking(club, SLOT));
    const retry = await send("retry-key-0001", booking(club, SLOT));
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect((await body(retry)).id).toBe((await body(first)).id);
  });

  test("errors are replayed too, so the outcome never changes", async () => {
    await h.request("/v1/bookings", { method: "POST", key: club.secretKey, json: booking(club, SLOT) });
    const lost = await send("retry-key-0002", booking(club, SLOT));
    expect(lost.status).toBe(409);
    await h.request("/v1/bookings?status=confirmed", { key: club.secretKey });
    const replay = await send("retry-key-0002", booking(club, SLOT));
    expect(replay.status).toBe(409);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
  });

  test("reusing a key for a different request is refused", async () => {
    await send("retry-key-0003", booking(club, SLOT));
    const other = await send("retry-key-0003", booking(club, "2026-10-30T19:30:00+01:00"));
    expect(other.status).toBe(422);
    expect(await body(other)).toMatchObject({ title: "Idempotency key reused" });
  });

  test("keys are scoped per organization", async () => {
    const other = await seedClub(h, "Other");
    const mine = await send("shared-key-0004", booking(club, SLOT));
    const theirs = await h.request("/v1/bookings", {
      method: "POST",
      key: other.secretKey,
      json: booking(other, SLOT),
      headers: { "idempotency-key": "shared-key-0004" },
    });
    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    expect(theirs.headers.get("idempotent-replayed")).toBeNull();
  });
});

describe("rate limits", () => {
  test("public widgets get 20 booking attempts a minute per IP, with standard headers", async () => {
    const attempt = (ip: string) =>
      h.request("/v1/bookings", {
        method: "POST",
        key: club.publishableKey,
        json: booking(club, "2026-10-26T08:15:00+01:00"), // closed: rejected, but counted
        headers: { "x-forwarded-for": ip },
      });
    for (let i = 0; i < 20; i++) expect((await attempt("203.0.113.7")).status).toBe(422);
    const limited = await attempt("203.0.113.7");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.headers.get("ratelimit-remaining")).toBe("0");
    expect((await attempt("198.51.100.20")).status).toBe(422); // another visitor is unaffected

    h.clock.advance(2); // two minutes later both windows have slid past
    expect((await attempt("203.0.113.7")).status).toBe(422);
  });

  test("responses tell clients where they stand", async () => {
    const response = await h.request("/v1/resources", { key: club.secretKey });
    expect(response.headers.get("ratelimit-limit")).toBe("600");
    expect(response.headers.get("ratelimit-remaining")).toBe("599");
  });
});

describe("authentication", () => {
  test("a missing or unknown key is a 401 problem with a request id", async () => {
    const missing = await h.request("/v1/bookings");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("content-type")).toBe("application/problem+json");
    const problem = await body(missing);
    expect(problem.requestId).toBe(missing.headers.get("x-request-id"));
    expect(problem.type).toContain("errors.md#unauthorized");
    const unknown = await h.request("/v1/bookings", { key: "sl_sk_not-a-real-key" });
    expect(unknown.status).toBe(401);
  });

  test("an incoming request id is propagated", async () => {
    const response = await h.request("/healthz", { headers: { "x-request-id": "trace-abc-12345" } });
    expect(response.headers.get("x-request-id")).toBe("trace-abc-12345");
  });

  test("scopes are enforced", async () => {
    const response = await h.request("/v1/bookings", { key: club.publishableKey });
    expect(response.status).toBe(403);
    expect(await body(response)).toMatchObject({ requiredScope: "bookings:read" });
  });
});
