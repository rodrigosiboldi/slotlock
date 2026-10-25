import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import type { Deps } from "../context";
import type { Executor } from "../db/client";
import { events, webhookDeliveries, webhookEndpoints } from "../db/schema";
import { uuidv7 } from "../lib/crypto";
import { problems } from "../lib/problem";

/** Wait before retry n (1-based). After the last one the delivery is marked failed. */
export const RETRY_DELAYS_SECONDS = [30, 120, 600, 3_600, 21_600];
const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;
const DELIVERY_TIMEOUT_MS = 8_000;
/** A claimed delivery is invisible to other dispatchers for this long, in case we crash mid-send. */
const LEASE_SECONDS = 60;

export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  active: boolean;
  createdAt: Date;
}

export interface WebhookDelivery {
  id: string;
  eventId: string;
  eventType: string;
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  nextAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  lastResponseStatus: number | null;
  lastError: string | null;
  lastDurationMs: number | null;
  createdAt: Date;
}

// ---------- endpoints ----------

export async function createEndpoint(
  deps: Pick<Deps, "db" | "secrets" | "config">,
  organizationId: string,
  input: { url: string; events: string[]; description?: string | undefined },
): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
  assertDeliverableUrl(input.url, isLocalDeployment(deps.config));
  // Standard Webhooks secret format: "whsec_" + base64 of the raw HMAC key.
  const secret = `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}`;
  const [row] = await deps.db
    .insert(webhookEndpoints)
    .values({
      id: uuidv7(),
      organizationId,
      url: input.url,
      description: input.description ?? null,
      events: input.events,
      secretCiphertext: await deps.secrets.encrypt(secret),
    })
    .returning();
  return { endpoint: toEndpoint(row as typeof webhookEndpoints.$inferSelect), secret };
}

export async function listEndpoints(db: Executor, organizationId: string): Promise<WebhookEndpoint[]> {
  const rows = await db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.organizationId, organizationId))
    .orderBy(asc(webhookEndpoints.id));
  return rows.map(toEndpoint);
}

export async function deleteEndpoint(db: Executor, organizationId: string, id: string): Promise<void> {
  const deleted = await db
    .delete(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.organizationId, organizationId)))
    .returning({ id: webhookEndpoints.id });
  if (deleted.length === 0) throw problems.notFound("Webhook endpoint");
}

export async function listDeliveries(
  db: Executor,
  organizationId: string,
  endpointId: string,
  limit: number,
): Promise<WebhookDelivery[]> {
  const [endpoint] = await db
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.organizationId, organizationId)));
  if (!endpoint) throw problems.notFound("Webhook endpoint");
  const rows = await db
    .select({ delivery: webhookDeliveries, eventType: events.type })
    .from(webhookDeliveries)
    .innerJoin(events, eq(events.id, webhookDeliveries.eventId))
    .where(eq(webhookDeliveries.endpointId, endpointId))
    .orderBy(desc(webhookDeliveries.id))
    .limit(limit);
  return rows.map(({ delivery, eventType }) => ({
    id: delivery.id,
    eventId: delivery.eventId,
    eventType,
    status: delivery.status,
    attempts: delivery.attempts,
    nextAttemptAt: delivery.status === "pending" ? delivery.nextAttemptAt : null,
    lastAttemptAt: delivery.lastAttemptAt,
    lastResponseStatus: delivery.lastResponseStatus,
    lastError: delivery.lastError,
    lastDurationMs: delivery.lastDurationMs,
    createdAt: delivery.createdAt,
  }));
}

function toEndpoint(row: typeof webhookEndpoints.$inferSelect): WebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: row.events,
    active: row.active,
    createdAt: row.createdAt,
  };
}

// ---------- signing (Standard Webhooks, https://www.standardwebhooks.com) ----------

export async function sign(secret: string, messageId: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(secret.replace(/^whsec_/, ""), "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${messageId}.${timestamp}.${body}`));
  return `v1,${Buffer.from(mac).toString("base64")}`;
}

/** Verifies a delivery the way a receiver should: signature, then a 5-minute timestamp tolerance. */
export async function verify(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  nowSeconds: number,
): Promise<boolean> {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const timestamp = Number(headers.timestamp);
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > 300) return false;
  const expected = await sign(secret, headers.id, timestamp, body);
  // The header may carry several space-separated signatures (during secret rotation).
  return headers.signature.split(" ").some((candidate) => timingSafeEqualString(candidate, expected));
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- dispatch ----------

/**
 * Sends the deliveries that are due. Safe to run from many places at once: rows are claimed with
 * FOR UPDATE SKIP LOCKED and leased for a minute, so concurrent dispatchers never send the same
 * delivery twice, and a dispatcher that dies mid-send only delays it until the lease runs out.
 */
export async function dispatchDue(
  deps: Pick<Deps, "db" | "secrets" | "fetch" | "clock" | "logger" | "metrics" | "config">,
  options: { limit?: number } = {},
): Promise<{ attempted: number; succeeded: number }> {
  const now = new Date(deps.clock.now().epochMilliseconds);
  const leaseUntil = new Date(now.getTime() + LEASE_SECONDS * 1000);
  const claimed = await deps.db
    .update(webhookDeliveries)
    .set({ nextAttemptAt: leaseUntil })
    .where(
      inArray(
        webhookDeliveries.id,
        deps.db
          .select({ id: webhookDeliveries.id })
          .from(webhookDeliveries)
          .where(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, now)))
          .orderBy(asc(webhookDeliveries.nextAttemptAt))
          .limit(options.limit ?? 25)
          .for("update", { skipLocked: true }),
      ),
    )
    .returning();
  if (claimed.length === 0) return { attempted: 0, succeeded: 0 };

  const endpointIds = [...new Set(claimed.map((delivery) => delivery.endpointId))];
  const eventIds = [...new Set(claimed.map((delivery) => delivery.eventId))];
  const [endpointRows, eventRows] = await Promise.all([
    deps.db.select().from(webhookEndpoints).where(inArray(webhookEndpoints.id, endpointIds)),
    deps.db.select().from(events).where(inArray(events.id, eventIds)),
  ]);
  const endpointById = new Map(endpointRows.map((row) => [row.id, row]));
  const eventById = new Map(eventRows.map((row) => [row.id, row]));

  const results = await Promise.all(
    claimed.map(async (delivery) => {
      const endpoint = endpointById.get(delivery.endpointId);
      const event = eventById.get(delivery.eventId);
      if (!endpoint || !event) return false;
      const outcome = await attempt(deps, delivery.id, endpoint, event);
      const attempts = delivery.attempts + 1;
      const delay = RETRY_DELAYS_SECONDS[attempts - 1];
      const finished = outcome.ok || attempts >= MAX_ATTEMPTS || delay === undefined;
      await deps.db
        .update(webhookDeliveries)
        .set({
          status: outcome.ok ? "succeeded" : finished ? "failed" : "pending",
          attempts,
          nextAttemptAt: finished ? now : new Date(now.getTime() + (delay ?? 0) * 1000),
          lastAttemptAt: now,
          lastResponseStatus: outcome.status,
          lastError: outcome.error,
          lastDurationMs: outcome.durationMs,
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      deps.metrics.webhookDeliveries.inc({ outcome: outcome.ok ? "succeeded" : finished ? "failed" : "retrying" });
      return outcome.ok;
    }),
  );
  return { attempted: claimed.length, succeeded: results.filter(Boolean).length };
}

async function attempt(
  deps: Pick<Deps, "secrets" | "fetch" | "clock" | "logger" | "config">,
  deliveryId: string,
  endpoint: typeof webhookEndpoints.$inferSelect,
  event: typeof events.$inferSelect,
): Promise<{ ok: boolean; status: number | null; error: string | null; durationMs: number }> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  try {
    await assertResolvesPublic(endpoint.url, isLocalDeployment(deps.config));
    const secret = await deps.secrets.decrypt(endpoint.secretCiphertext);
    const timestamp = Math.floor(deps.clock.now().epochMilliseconds / 1000);
    const body = JSON.stringify({ type: event.type, timestamp: event.createdAt.toISOString(), data: event.data });
    const response = await deps.fetch(endpoint.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "user-agent": "Slotlock-Webhooks/1.0",
        "webhook-id": deliveryId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": await sign(secret, deliveryId, timestamp, body),
      },
      body,
    });
    await response.body?.cancel();
    const ok = response.status >= 200 && response.status < 300;
    return { ok, status: response.status, error: ok ? null : `HTTP ${response.status}`, durationMs: elapsed() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn("webhook delivery failed", { deliveryId, endpointId: endpoint.id, error: message });
    return { ok: false, status: null, error: message.slice(0, 300), durationMs: elapsed() };
  }
}

// ---------- SSRF protection ----------

/**
 * Local targets (http://localhost…) are allowed only when the API itself runs on localhost,
 * so the strict rules hold on every real deployment whatever NODE_ENV says.
 */
export function isLocalDeployment(config: Pick<Deps["config"], "publicUrl">): boolean {
  return isLocalHostname(new URL(config.publicUrl).hostname);
}

/** Webhooks go to the public internet only: no private, loopback or link-local targets. */
export function assertDeliverableUrl(raw: string, allowLocal: boolean): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw problems.unprocessable("invalid-webhook-url", "Invalid webhook URL", "Use an absolute https:// URL.");
  }
  const local = isLocalHostname(url.hostname);
  if (url.protocol !== "https:" && !(allowLocal && local && url.protocol === "http:")) {
    throw problems.unprocessable("invalid-webhook-url", "Invalid webhook URL", "Webhook URLs must use https.");
  }
  if (url.username || url.password) {
    throw problems.unprocessable(
      "invalid-webhook-url",
      "Invalid webhook URL",
      "Credentials in the URL are not allowed.",
    );
  }
  if (!allowLocal && (local || (isIP(stripBrackets(url.hostname)) && isPrivateAddress(stripBrackets(url.hostname))))) {
    throw problems.unprocessable(
      "invalid-webhook-url",
      "Invalid webhook URL",
      "Webhooks cannot target private networks.",
    );
  }
}

/** DNS can change after registration, so the resolved addresses are checked before every send. */
async function assertResolvesPublic(raw: string, allowLocal: boolean): Promise<void> {
  if (allowLocal) return;
  const hostname = stripBrackets(new URL(raw).hostname);
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error(`Refusing to deliver to private address for ${hostname}`);
  }
}

function isLocalHostname(hostname: string): boolean {
  const host = stripBrackets(hostname).toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1";
}

/**
 * True for anything that is not a public unicast address: private, loopback, link-local,
 * shared, reserved and multicast ranges, plus IPv6 forms that embed or translate to an IPv4
 * address (mapped, compatible, NAT64, 6to4), which are judged by that IPv4 address.
 */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isPrivateV4(address.split(".").map(Number));
  if (kind !== 6) return true;
  const h = expandV6(address);
  if (!h) return true;
  const word = (i: number) => h[i] ?? 0;
  const embedded = (i: number) => [word(i) >> 8, word(i) & 255, word(i + 1) >> 8, word(i + 1) & 255];
  const zeros = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return true; // ::
  if (zeros(0, 7) && word(7) === 1) return true; // ::1
  if (zeros(0, 5) && word(5) === 0xffff) return isPrivateV4(embedded(6)); // ::ffff:a.b.c.d, however written
  if (zeros(0, 6)) return isPrivateV4(embedded(6)); // ::a.b.c.d (deprecated)
  if (word(0) === 0x64 && word(1) === 0xff9b && zeros(2, 6)) return isPrivateV4(embedded(6)); // NAT64
  if (word(0) === 0x64 && word(1) === 0xff9b && word(2) === 1) return true; // local-use NAT64
  if (word(0) === 0x2002) return isPrivateV4(embedded(1)); // 6to4
  if ((word(0) & 0xfe00) === 0xfc00) return true; // unique local
  if ((word(0) & 0xffc0) === 0xfe80 || (word(0) & 0xffc0) === 0xfec0) return true; // link- and site-local
  if ((word(0) & 0xff00) === 0xff00) return true; // multicast
  if (word(0) === 0x2001 && word(1) === 0x0db8) return true; // documentation
  if (word(0) === 0x0100 && zeros(1, 4)) return true; // discard-only
  return false;
}

function isPrivateV4([a = 0, b = 0, c = 0]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Eight 16-bit words of an IPv6 address (with "::" and an IPv4 tail expanded), or null. */
function expandV6(address: string): number[] | null {
  let text = (address.toLowerCase().split("%")[0] ?? "").trim();
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const [, a = 0, b = 0, c = 0, d = 0] = tail.map(Number);
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  const parts = rest === null ? head : [...head, ...Array(8 - head.length - rest.length).fill("0"), ...rest];
  if (parts.length !== 8) return null;
  const words = parts.map((part) => (/^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : Number.NaN));
  return words.some(Number.isNaN) ? null : words;
}

function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}
