import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv, Deps } from "./context";
import { onError, onNotFound, problemResponse, validationHook } from "./http/errors";
import { authenticate, idempotency, observe, raceTicket, rateLimit } from "./http/middleware";
import { registerBookingRoutes } from "./http/routes/bookings";
import { registerCatalogRoutes } from "./http/routes/catalog";
import { registerDemoRoutes } from "./http/routes/demo";
import { registerSystemRoutes } from "./http/routes/system";
import { registerWebhookRoutes } from "./http/routes/webhooks";
import { PROBLEM_DOCS, problems } from "./lib/problem";
import { resetDemo } from "./services/demo";

export const API_DESCRIPTION = `
A multi-tenant booking API that **cannot double-book**.

Two requests for the same slot never both succeed — not because the application checks first, but
because Postgres refuses the second one: bookings carry an exclusion constraint over
\`(resource, [start − buffer, end + buffer))\`. It holds under any concurrency, on any instance,
and even for writes that never go through this API.

## Authentication
\`Authorization: Bearer <key>\`. **Secret keys** (\`sl_sk_…\`) are for your servers and can do
everything their scopes allow. **Publishable keys** (\`sl_pk_…\`) are safe to embed in a public booking
widget: they can read the catalogue and availability and create bookings, under customer rules
(slot grid, minimum notice, booking window).

## Errors
Every error is [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) \`application/problem+json\` with a
stable \`type\` you can branch on, documented in [errors.md](${PROBLEM_DOCS}), and a \`requestId\` to quote.

## Retries
Send an \`Idempotency-Key\` with any \`POST\`. Repeating the request returns the stored response
(\`Idempotent-Replayed: true\`) for 24 hours; reusing a key for a different request is refused.

## Rate limits
Sliding windows shared by every instance: 600 requests/min per secret key, 120/min per publishable
key and IP (20 booking attempts/min). Every response says where you stand: \`RateLimit-Limit\`,
\`RateLimit-Remaining\`, \`RateLimit-Reset\`.

## Time
Opening hours are wall-clock times in each resource's IANA zone; everything else is an instant.
Responses carry offsets (\`2026-10-25T02:30:00+01:00\`), so the hour that repeats when clocks go back
is never ambiguous.

## Webhooks
\`booking.created\`, \`booking.cancelled\` and \`booking.rescheduled\`, signed per
[Standard Webhooks](https://www.standardwebhooks.com). They are written to an outbox in the same
transaction as the booking, so a committed booking always produces its event.
`.trim();

export function createApp(deps: Deps) {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });

  app.use("*", observe(deps));
  app.use("*", secureHeaders({ crossOriginResourcePolicy: "cross-origin", crossOriginEmbedderPolicy: false }));
  app.use(
    "/v1/*",
    cors({
      origin: "*",
      allowHeaders: [
        "authorization",
        "content-type",
        "idempotency-key",
        "x-request-id",
        "x-slotlock-race",
        "last-event-id",
      ],
      exposeHeaders: [
        "x-request-id",
        "location",
        "retry-after",
        "idempotent-replayed",
        "ratelimit-limit",
        "ratelimit-remaining",
        "ratelimit-reset",
      ],
      maxAge: 600,
    }),
  );
  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) =>
        problemResponse(c, problems.unprocessable("body-too-large", "Body too large", "Keep requests under 64 KB.")),
    }),
  );
  app.use("/v1/*", authenticate(deps));
  app.use("/v1/bookings", raceTicket(deps));
  app.use("/v1/*", rateLimit(deps));
  app.use("/v1/*", idempotency(deps));

  app.onError(onError);
  app.notFound(onNotFound);

  app.openAPIRegistry.registerComponent("securitySchemes", "ApiKey", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "sl_sk_… or sl_pk_…",
    description: "A secret key (servers) or a publishable key (public booking widgets).",
  });

  registerSystemRoutes(app, deps, deps.config.demoEnabled ? { resetDemo: () => resetDemo(deps) } : {});
  registerCatalogRoutes(app, deps);
  registerBookingRoutes(app, deps);
  registerWebhookRoutes(app, deps);
  if (deps.config.demoEnabled) registerDemoRoutes(app, deps);

  app.doc31("/openapi.json", () => ({
    openapi: "3.1.0",
    info: {
      title: "Slotlock API",
      version: "1.0.0",
      description: API_DESCRIPTION,
      contact: { name: "Rodrigo Siboldi", url: "https://rodrigosiboldi.com" },
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: deps.config.publicUrl }],
    tags: [
      { name: "Availability", description: "Open slots, computed from opening hours, bookings, buffers and time off." },
      { name: "Bookings", description: "Create, list, cancel and move bookings." },
      { name: "Resources", description: "What gets booked (courts, rooms, people), their hours and time off." },
      { name: "Services", description: "What is offered: duration, buffers, booking rules." },
      { name: "Webhooks", description: "Signed, retried notifications of every change." },
      { name: "Events", description: "The outbox, as a pollable feed." },
      { name: "Organization", description: "The account behind the API key." },
      { name: "System", description: "Health and readiness." },
    ],
  }));

  app.get(
    "/docs",
    Scalar({
      url: "/openapi.json",
      pageTitle: "Slotlock API reference",
      theme: "deepSpace",
      defaultHttpClient: { targetKey: "js", clientKey: "fetch" },
      hideClientButton: false,
    }),
  );

  return app;
}

export type App = ReturnType<typeof createApp>;
