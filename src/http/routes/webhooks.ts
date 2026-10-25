import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv, Deps } from "../../context";
import { problems } from "../../lib/problem";
import { decodeFeedCursor, EVENT_TYPES, encodeFeedCursor, eventsAfter } from "../../services/events";
import { createEndpoint, deleteEndpoint, listDeliveries, listEndpoints } from "../../services/webhooks";
import { requireScope } from "../middleware";
import {
  commonErrors,
  DeliverySchema,
  EventSchema,
  IdempotencyHeader,
  IdParam,
  PageQuery,
  problemSpec,
  WebhookEndpointCreatedSchema,
  WebhookEndpointInputSchema,
  WebhookEndpointSchema,
} from "../schemas";
import { serializeDelivery, serializeEndpoint, serializeEvent } from "../serialize";

const security = [{ ApiKey: [] }];
const json = <T>(schema: T) => ({ "application/json": { schema } });
const ENDPOINT_ID = "0199c3e5-3c4d-7e5f-8a6b-7c8d9e0f1a23";

export function registerWebhookRoutes(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/webhook-endpoints",
      tags: ["Webhooks"],
      summary: "Subscribe to events",
      description:
        "Deliveries follow the Standard Webhooks spec: `webhook-id`, `webhook-timestamp` and `webhook-signature` " +
        "(HMAC-SHA256 with the secret returned here, shown once). Failed deliveries are retried after 30 s, 2 min, " +
        "10 min, 1 h and 6 h. URLs must be https and public; private networks are refused, before and at delivery.",
      security,
      middleware: [requireScope("webhooks:manage")] as const,
      request: { headers: IdempotencyHeader, body: { content: json(WebhookEndpointInputSchema), required: true } },
      responses: {
        201: { description: "Subscribed. Store the secret now.", content: json(WebhookEndpointCreatedSchema) },
        422: problemSpec("The URL is not https, or targets a private network."),
        ...commonErrors,
      },
    }),
    async (c) => {
      const { endpoint, secret } = await createEndpoint(deps, c.var.auth.organizationId, c.req.valid("json"));
      return c.json({ ...serializeEndpoint(endpoint), secret }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/webhook-endpoints",
      tags: ["Webhooks"],
      summary: "List subscriptions",
      security,
      middleware: [requireScope("webhooks:manage")] as const,
      responses: {
        200: {
          description: "Every endpoint.",
          content: json(z.object({ object: z.literal("list"), data: z.array(WebhookEndpointSchema) })),
        },
        ...commonErrors,
      },
    }),
    async (c) => {
      const endpoints = await listEndpoints(deps.db, c.var.auth.organizationId);
      return c.json({ object: "list" as const, data: endpoints.map(serializeEndpoint) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/webhook-endpoints/{id}",
      tags: ["Webhooks"],
      summary: "Unsubscribe",
      security,
      middleware: [requireScope("webhooks:manage")] as const,
      request: { params: IdParam("Webhook endpoint", ENDPOINT_ID) },
      responses: { 204: { description: "Deleted." }, 404: problemSpec("No such endpoint."), ...commonErrors },
    }),
    async (c) => {
      await deleteEndpoint(deps.db, c.var.auth.organizationId, c.req.valid("param").id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/webhook-endpoints/{id}/deliveries",
      tags: ["Webhooks"],
      summary: "Delivery log",
      description: "The latest delivery attempts to this endpoint, newest first: status, attempts, timing, errors.",
      security,
      middleware: [requireScope("webhooks:manage")] as const,
      request: {
        params: IdParam("Webhook endpoint", ENDPOINT_ID),
        query: z.object({ limit: PageQuery.limit }),
      },
      responses: {
        200: {
          description: "Deliveries.",
          content: json(z.object({ object: z.literal("list"), data: z.array(DeliverySchema) })),
        },
        404: problemSpec("No such endpoint."),
        ...commonErrors,
      },
    }),
    async (c) => {
      const deliveries = await listDeliveries(
        deps.db,
        c.var.auth.organizationId,
        c.req.valid("param").id,
        c.req.valid("query").limit,
      );
      return c.json({ object: "list" as const, data: deliveries.map(serializeDelivery) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/events",
      tags: ["Events"],
      summary: "Event feed",
      description:
        "Every change, oldest first, from the same outbox webhooks are sent from. Poll it with `nextCursor` " +
        "if you cannot receive webhooks: it is always returned, even on the last page, and no event is ever " +
        "skipped — events appear in the order their transactions became safe to read, not merely by id.",
      security,
      middleware: [requireScope("bookings:read")] as const,
      request: { query: z.object({ ...PageQuery, type: z.enum(EVENT_TYPES).optional() }) },
      responses: {
        200: {
          description: "A page of events.",
          content: json(
            z
              .object({
                object: z.literal("list"),
                data: z.array(EventSchema),
                nextCursor: z
                  .string()
                  .nullable()
                  .openapi({ description: "Resume from here next time; null only before the first event exists." }),
                hasMore: z.boolean().openapi({ description: "Whether another page is ready right now." }),
              })
              .openapi("EventList"),
          ),
        },
        ...commonErrors,
      },
    }),
    async (c) => {
      const { limit, cursor, type } = c.req.valid("query");
      const after = cursor ? decodeFeedCursor(cursor) : null;
      if (cursor && !after) throw problems.validation([{ path: "cursor", message: "Invalid or expired cursor." }]);
      const rows = await eventsAfter(deps.db, c.var.auth.organizationId, after, { limit: limit + 1, type });
      const page = rows.slice(0, limit);
      const last = page.at(-1)?.cursor ?? after;
      return c.json(
        {
          object: "list" as const,
          data: page.map(serializeEvent),
          nextCursor: last ? encodeFeedCursor(last) : null,
          hasMore: rows.length > limit,
        },
        200,
      );
    },
  );
}
