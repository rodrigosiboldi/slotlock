import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, Deps, Scope } from "../context";
import { sha256Hex, uuidv7 } from "../lib/crypto";
import { problems } from "../lib/problem";
import { authenticateKey } from "../services/api-keys";
import { claimKey, completeKey, releaseKey } from "../services/idempotency";
import { hit, POLICIES, type RatePolicy } from "../services/rate-limit";
import { problemResponse } from "./errors";

const REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** Request id, structured access log and HTTP metrics, all in one wrapper. */
export function observe(deps: Pick<Deps, "logger" | "metrics">): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : uuidv7();
    const log = deps.logger.child({ requestId });
    c.set("requestId", requestId);
    c.set("log", log);
    const started = performance.now();
    await next();
    const seconds = (performance.now() - started) / 1000;
    const route = c.req.routePath === "/*" ? "unmatched" : c.req.routePath;
    c.res.headers.set("x-request-id", requestId);
    deps.metrics.httpRequests.inc({ method: c.req.method, route, status: c.res.status });
    deps.metrics.httpDuration.observe({ method: c.req.method, route }, seconds);
    log.info("request", {
      method: c.req.method,
      path: c.req.path,
      route,
      status: c.res.status,
      durationMs: Math.round(seconds * 1000),
      ...(c.var.auth ? { organizationId: c.var.auth.organizationId, keyId: c.var.auth.keyId } : {}),
    });
  };
}

/** Bearer API keys. Every /v1 route needs one; scopes are checked per route. */
export function authenticate(deps: Pick<Deps, "db" | "clock" | "background">): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header("authorization");
    const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (!match?.[1]) return problemResponse(c, problems.unauthorized());
    const auth = await authenticateKey(deps, match[1]);
    if (!auth) return problemResponse(c, problems.unauthorized("The API key is unknown or has been revoked."));
    c.set("auth", auth);
    await next();
  };
}

export function requireScope(scope: Scope): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.var.auth.scopes.has(scope)) return problemResponse(c, problems.forbidden(scope));
    await next();
  };
}

/**
 * Shared limits per key (secret) or per key and client IP (publishable). Booking attempts from
 * public widgets get a tighter policy; a valid demo race ticket swaps in the race's own budget.
 */
export function rateLimit(deps: Pick<Deps, "db" | "clock" | "metrics" | "config">): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.var.auth;
    const policies: [RatePolicy, string][] = [];
    if (c.var.race) {
      policies.push([POLICIES.race, c.var.race.id]);
    } else if (auth.kind === "secret") {
      policies.push([POLICIES.secretKey, auth.keyId]);
    } else {
      const subject = `${auth.keyId}:${clientIp(c, deps.config.trustProxy)}`;
      policies.push([POLICIES.publishableKey, subject]);
      if (c.req.method === "POST" && c.req.path === "/v1/bookings") policies.push([POLICIES.publicBookings, subject]);
    }
    const nowMs = deps.clock.now().epochMilliseconds;
    let tightest = null as Awaited<ReturnType<typeof hit>> | null;
    for (const [policy, subject] of policies) {
      const decision = await hit(deps.db, policy, subject, nowMs);
      if (!decision.allowed) {
        deps.metrics.rateLimited.inc({ policy: policy.name });
        const response = problemResponse(c, problems.rateLimited(decision.resetSeconds));
        setRateHeaders(response.headers, decision);
        return response;
      }
      if (!tightest || decision.remaining < tightest.remaining) tightest = decision;
    }
    await next();
    if (tightest) setRateHeaders(c.res.headers, tightest);
  };
}

function setRateHeaders(headers: Headers, decision: { limit: number; remaining: number; resetSeconds: number }) {
  headers.set("ratelimit-limit", String(decision.limit));
  headers.set("ratelimit-remaining", String(decision.remaining));
  headers.set("ratelimit-reset", String(decision.resetSeconds));
}

/**
 * Stripe-style idempotency for POST requests that carry an Idempotency-Key header. The response
 * (success or client error) is stored and replayed for repeats of the same request; transient
 * failures (5xx, 429) release the key so the client can retry with it.
 */
export function idempotency(deps: Pick<Deps, "db" | "clock">): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = c.req.header("idempotency-key");
    if (c.req.method !== "POST" || !key) return next();
    if (key.length < 8 || key.length > 200) {
      return problemResponse(c, problems.validation([{ path: "Idempotency-Key", message: "Use 8–200 characters." }]));
    }
    const organizationId = c.var.auth.organizationId;
    const body = await c.req.text();
    // The key id is part of the fingerprint: a replay must come from the same API key, so a
    // publishable key can never read back what a secret key stored under a guessable key.
    const fingerprint = sha256Hex(`${c.var.auth.keyId}\n${c.req.method} ${c.req.path}\n${body}`);
    const now = () => new Date(deps.clock.now().epochMilliseconds);

    const claim = await claimKey(deps.db, { organizationId, key, fingerprint, now: now() });
    if (claim.state === "replay") {
      return c.json(claim.body as object, claim.status as 200, { "idempotent-replayed": "true" });
    }
    if (claim.state === "mismatch") {
      return problemResponse(
        c,
        problems.unprocessable(
          "idempotency-key-reused",
          "Idempotency key reused",
          "This key was already used for a different request. Use a new key for a new request.",
        ),
      );
    }
    if (claim.state === "in-progress") {
      const problem = problems.conflict(
        "idempotency-key-in-progress",
        "Request already in progress",
        "A request with this key is still being processed. Retry shortly.",
      );
      const response = problemResponse(c, problem);
      response.headers.set("retry-after", "1");
      return response;
    }

    await next();
    const status = c.res.status;
    if (status >= 500 || status === 429) {
      await releaseKey(deps.db, { organizationId, key });
      return;
    }
    const stored = await c.res
      .clone()
      .json()
      .catch(() => null);
    await completeKey(deps.db, { organizationId, key, status, body: stored, now: now() });
  };
}

/** The demo's race tickets: `X-Slotlock-Race: <signed raceId:resourceId:expiresAt>`. */
export function raceTicket(deps: Pick<Deps, "secrets" | "clock">): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ticket = c.req.header("x-slotlock-race");
    if (ticket) {
      const payload = await deps.secrets.verify(ticket);
      const [kind, raceId, resourceId, expires] = payload?.split(":") ?? [];
      const valid =
        kind === "race" && raceId && resourceId && Number(expires) * 1000 > deps.clock.now().epochMilliseconds;
      if (!valid) {
        return problemResponse(
          c,
          problems.unprocessable(
            "invalid-race-ticket",
            "Invalid race ticket",
            "The ticket is malformed or has expired.",
          ),
        );
      }
      c.set("race", { id: raceId, resourceId });
    }
    await next();
  };
}

export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  const server = (c.env as { server?: { requestIP(request: Request): { address: string } | null } } | undefined)
    ?.server;
  return server?.requestIP(c.req.raw)?.address ?? "unknown";
}
