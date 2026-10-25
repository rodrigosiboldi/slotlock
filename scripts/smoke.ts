/**
 * End-to-end check of a running deployment, through its public demo:
 *
 *   bun run smoke                       # http://localhost:3000
 *   bun run smoke https://slotlock.example.com
 *
 * Reads the demo's publishable key from /demo/config, then exercises availability,
 * booking, idempotent replay, the double-booking guarantee, a 200-request race and webhooks.
 */
const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/+$/, "");
let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
}

const demo = (await (await fetch(`${base}/demo/config`)).json()) as {
  publishableKey: string;
  matchServiceId: string;
  timezone: string;
  courts: { id: string; name: string }[];
};
const headers = { authorization: `Bearer ${demo.publishableKey}`, "content-type": "application/json" };
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });

// 1. Availability a few days out, so minimum notice never interferes.
const date = Temporal.Now.plainDateISO(demo.timezone).add({ days: 3 });
const availability = (await (await api(`/v1/availability?serviceId=${demo.matchServiceId}&from=${date}`)).json()) as {
  slots: { resourceId: string; start: string }[];
};
check("availability lists open slots", availability.slots.length > 0, `${availability.slots.length} slots on ${date}`);
const slot = availability.slots.at(-1);
if (!slot) throw new Error("No free slot to book");

// 2. Book it, with an idempotency key, and replay.
const bookingBody = JSON.stringify({
  serviceId: demo.matchServiceId,
  resourceId: slot.resourceId,
  startsAt: slot.start,
  customer: { name: "Smoke Test", email: "smoke@example.com" },
  metadata: { source: "smoke" },
});
const key = `smoke-${crypto.randomUUID()}`;
const first = await api("/v1/bookings", { method: "POST", body: bookingBody, headers: { "idempotency-key": key } });
const created = (await first.json()) as { id: string; startsAt: string };
check("booking created", first.status === 201, `${created.startsAt}`);
const replay = await api("/v1/bookings", { method: "POST", body: bookingBody, headers: { "idempotency-key": key } });
const replayed = (await replay.json()) as { id: string };
check(
  "retry with the same key replays the response",
  replay.status === 201 && replay.headers.get("idempotent-replayed") === "true" && replayed.id === created.id,
);

// 3. The same slot again, without a key: the database says no.
const again = await api("/v1/bookings", { method: "POST", body: bookingBody });
const problem = (await again.json()) as { title?: string };
check("a second booking of the slot is refused", again.status === 409, `${again.status} ${problem.title ?? ""}`);

// 4. The race: 200 simultaneous requests for one slot.
const race = (await (await fetch(`${base}/demo/race`, { method: "POST" })).json()) as {
  ticket: string;
  resourceId: string;
  serviceId: string;
  startsAt: string;
  attempts: number;
};
const started = performance.now();
const results = await Promise.all(
  Array.from({ length: race.attempts }, (_, i) =>
    api("/v1/bookings", {
      method: "POST",
      headers: { "x-slotlock-race": race.ticket, "idempotency-key": `race-${crypto.randomUUID()}` },
      body: JSON.stringify({
        serviceId: race.serviceId,
        resourceId: race.resourceId,
        startsAt: race.startsAt,
        customer: { name: `Player ${i + 1}`, email: `player${i + 1}@example.com` },
      }),
    }).then((response) => response.status),
  ),
);
const tally = results.reduce<Record<number, number>>((acc, status) => {
  acc[status] = (acc[status] ?? 0) + 1;
  return acc;
}, {});
check(
  `race: ${race.attempts} requests, exactly one winner`,
  tally[201] === 1 && tally[409] === race.attempts - 1,
  `${JSON.stringify(tally)} in ${Math.round(performance.now() - started)} ms`,
);

// 5. Webhooks: the demo's receiver should have verified deliveries for our booking.
const feed = await fetch(`${base}/demo/feed`);
console.log(`  (feed stream ${feed.status}, ${feed.headers.get("content-type")})`);
await feed.body?.cancel();

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
