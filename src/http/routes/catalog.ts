import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppEnv, Deps } from "../../context";
import { organizations } from "../../db/schema";
import { problems } from "../../lib/problem";
import {
  addTimeOff,
  createResource,
  createService,
  deleteTimeOff,
  getResource,
  getService,
  isValidTimeZone,
  listResources,
  listServices,
  listTimeOff,
  updateResource,
  updateService,
  validateOpeningHours,
} from "../../services/catalog";
import { requireScope } from "../middleware";
import {
  commonErrors,
  EXAMPLE_IDS,
  IdempotencyHeader,
  IdParam,
  Instant,
  ListMeta,
  OrganizationSchema,
  PageQuery,
  problemSpec,
  ResourceInputSchema,
  ResourcePatchSchema,
  ResourceSchema,
  ServiceInputSchema,
  ServicePatchSchema,
  ServiceSchema,
  TimeOffInputSchema,
  TimeOffSchema,
} from "../schemas";
import {
  decodeCursor,
  encodeCursor,
  isUuid,
  serializeResource,
  serializeService,
  serializeTimeOff,
} from "../serialize";

const security = [{ ApiKey: [] }];
const json = <T>(schema: T) => ({ "application/json": { schema } });

export function registerCatalogRoutes(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  // ---------- organization ----------

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/organization",
      tags: ["Organization"],
      summary: "Who am I",
      description: "The organization the API key belongs to, and what the key may do.",
      security,
      responses: { 200: { description: "The organization.", content: json(OrganizationSchema) }, ...commonErrors },
    }),
    async (c) => {
      const auth = c.var.auth;
      const [org] = await deps.db.select().from(organizations).where(eq(organizations.id, auth.organizationId));
      if (!org) throw problems.notFound("Organization");
      return c.json(
        {
          id: org.id,
          object: "organization" as const,
          name: org.name,
          slug: org.slug,
          timezone: org.timezone,
          apiKey: { kind: auth.kind, scopes: [...auth.scopes] },
        },
        200,
      );
    },
  );

  // ---------- resources ----------

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/resources",
      tags: ["Resources"],
      summary: "List resources",
      security,
      middleware: [requireScope("catalog:read")] as const,
      request: { query: z.object(PageQuery) },
      responses: {
        200: {
          description: "A page of resources, oldest first.",
          content: json(z.object({ ...ListMeta, data: z.array(ResourceSchema) }).openapi("ResourceList")),
        },
        ...commonErrors,
      },
    }),
    async (c) => {
      const { limit, cursor } = c.req.valid("query");
      const after = decodeCursor(cursor, isUuid);
      const rows = await listResources(deps.db, c.var.auth.organizationId, {
        limit: limit + 1,
        ...(after ? { after } : {}),
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return c.json(
        {
          object: "list" as const,
          data: page.map(serializeResource),
          nextCursor: rows.length > limit && last ? encodeCursor(last.id) : null,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/resources",
      tags: ["Resources"],
      summary: "Create a resource",
      description: "A court, room or person, with its weekly opening hours in its own time zone.",
      security,
      middleware: [requireScope("catalog:write")] as const,
      request: { headers: IdempotencyHeader, body: { content: json(ResourceInputSchema), required: true } },
      responses: {
        201: { description: "Created.", content: json(ResourceSchema) },
        422: problemSpec("Invalid time zone or overlapping opening hours."),
        ...commonErrors,
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const timezone = input.timezone ?? c.var.auth.timezone;
      assertCatalogInput(timezone, input.openingHours);
      const resource = await createResource(deps.db, c.var.auth.organizationId, { ...input, timezone });
      return c.json(serializeResource(resource), 201, { location: `/v1/resources/${resource.id}` });
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/resources/{id}",
      tags: ["Resources"],
      summary: "Get a resource",
      security,
      middleware: [requireScope("catalog:read")] as const,
      request: { params: IdParam("Resource", EXAMPLE_IDS.RESOURCE_ID) },
      responses: {
        200: { description: "The resource.", content: json(ResourceSchema) },
        404: problemSpec("No such resource."),
        ...commonErrors,
      },
    }),
    async (c) => {
      const resource = await getResource(deps.db, c.var.auth.organizationId, c.req.valid("param").id);
      if (!resource) throw problems.notFound("Resource");
      return c.json(serializeResource(resource), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/resources/{id}",
      tags: ["Resources"],
      summary: "Update a resource",
      description: "Fields you send replace the stored ones; `openingHours`, when present, replaces the whole week.",
      security,
      middleware: [requireScope("catalog:write")] as const,
      request: {
        params: IdParam("Resource", EXAMPLE_IDS.RESOURCE_ID),
        body: { content: json(ResourcePatchSchema), required: true },
      },
      responses: {
        200: { description: "The updated resource.", content: json(ResourceSchema) },
        404: problemSpec("No such resource."),
        422: problemSpec("Invalid time zone or overlapping opening hours."),
        ...commonErrors,
      },
    }),
    async (c) => {
      const patch = c.req.valid("json");
      assertCatalogInput(patch.timezone, patch.openingHours);
      const resource = await updateResource(deps.db, c.var.auth.organizationId, c.req.valid("param").id, patch);
      return c.json(serializeResource(resource), 200);
    },
  );

  // ---------- time off ----------

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/resources/{id}/time-off",
      tags: ["Resources"],
      summary: "List time off",
      security,
      middleware: [requireScope("catalog:read")] as const,
      request: {
        params: IdParam("Resource", EXAMPLE_IDS.RESOURCE_ID),
        query: z.object({ from: Instant, to: Instant.openapi({ example: "2026-11-30T00:00:00+01:00" }) }),
      },
      responses: {
        200: {
          description: "Time off overlapping [from, to).",
          content: json(z.object({ object: z.literal("list"), data: z.array(TimeOffSchema) })),
        },
        404: problemSpec("No such resource."),
        ...commonErrors,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { from, to } = c.req.valid("query");
      const resource = await getResource(deps.db, c.var.auth.organizationId, id);
      if (!resource) throw problems.notFound("Resource");
      const entries = await listTimeOff(deps.db, c.var.auth.organizationId, id, {
        from: new Date(from),
        to: new Date(to),
      });
      return c.json(
        { object: "list" as const, data: entries.map((entry) => serializeTimeOff(entry, resource.timezone)) },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/resources/{id}/time-off",
      tags: ["Resources"],
      summary: "Add time off",
      description: "Blocks the resource. Refused with 409 if it overlaps confirmed bookings.",
      security,
      middleware: [requireScope("catalog:write")] as const,
      request: {
        params: IdParam("Resource", EXAMPLE_IDS.RESOURCE_ID),
        headers: IdempotencyHeader,
        body: { content: json(TimeOffInputSchema), required: true },
      },
      responses: {
        201: { description: "Created.", content: json(TimeOffSchema) },
        404: problemSpec("No such resource."),
        409: problemSpec("Overlaps confirmed bookings; their ids are in `bookingIds`."),
        422: problemSpec("The range is empty or reversed."),
        ...commonErrors,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const startsAt = new Date(input.startsAt);
      const endsAt = new Date(input.endsAt);
      if (startsAt >= endsAt)
        throw problems.unprocessable("invalid-range", "Invalid range", "`endsAt` must be after `startsAt`.");
      const entry = await addTimeOff(deps.db, c.var.auth.organizationId, id, {
        startsAt,
        endsAt,
        reason: input.reason,
      });
      const resource = await getResource(deps.db, c.var.auth.organizationId, id);
      return c.json(serializeTimeOff(entry, resource?.timezone ?? "UTC"), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/resources/{id}/time-off/{timeOffId}",
      tags: ["Resources"],
      summary: "Remove time off",
      security,
      middleware: [requireScope("catalog:write")] as const,
      request: {
        params: z.object({
          id: z.uuid().openapi({ param: { name: "id", in: "path" } }),
          timeOffId: z.uuid().openapi({ param: { name: "timeOffId", in: "path" } }),
        }),
      },
      responses: { 204: { description: "Removed." }, 404: problemSpec("No such time off."), ...commonErrors },
    }),
    async (c) => {
      const { id, timeOffId } = c.req.valid("param");
      await deleteTimeOff(deps.db, c.var.auth.organizationId, id, timeOffId);
      return c.body(null, 204);
    },
  );

  // ---------- services ----------

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/services",
      tags: ["Services"],
      summary: "List services",
      security,
      middleware: [requireScope("catalog:read")] as const,
      request: { query: z.object(PageQuery) },
      responses: {
        200: {
          description: "A page of services, oldest first.",
          content: json(z.object({ ...ListMeta, data: z.array(ServiceSchema) }).openapi("ServiceList")),
        },
        ...commonErrors,
      },
    }),
    async (c) => {
      const { limit, cursor } = c.req.valid("query");
      const after = decodeCursor(cursor, isUuid);
      const rows = await listServices(deps.db, c.var.auth.organizationId, {
        limit: limit + 1,
        ...(after ? { after } : {}),
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return c.json(
        {
          object: "list" as const,
          data: page.map(serializeService),
          nextCursor: rows.length > limit && last ? encodeCursor(last.id) : null,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/services",
      tags: ["Services"],
      summary: "Create a service",
      description: "Duration, buffers, slot grid and booking window, offered on one or more resources.",
      security,
      middleware: [requireScope("catalog:write")] as const,
      request: { headers: IdempotencyHeader, body: { content: json(ServiceInputSchema), required: true } },
      responses: {
        201: { description: "Created.", content: json(ServiceSchema) },
        422: problemSpec("A resource id does not belong to your organization."),
        ...commonErrors,
      },
    }),
    async (c) => {
      const service = await createService(deps.db, c.var.auth.organizationId, c.req.valid("json"));
      return c.json(serializeService(service), 201, { location: `/v1/services/${service.id}` });
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/services/{id}",
      tags: ["Services"],
      summary: "Get a service",
      security,
      middleware: [requireScope("catalog:read")] as const,
      request: { params: IdParam("Service", EXAMPLE_IDS.SERVICE_ID) },
      responses: {
        200: { description: "The service.", content: json(ServiceSchema) },
        404: problemSpec("No such service."),
        ...commonErrors,
      },
    }),
    async (c) => {
      const service = await getService(deps.db, c.var.auth.organizationId, c.req.valid("param").id);
      if (!service) throw problems.notFound("Service");
      return c.json(serializeService(service), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/services/{id}",
      tags: ["Services"],
      summary: "Update a service",
      description: "Changes apply to new bookings; existing bookings keep the times they were made with.",
      security,
      middleware: [requireScope("catalog:write")] as const,
      request: {
        params: IdParam("Service", EXAMPLE_IDS.SERVICE_ID),
        body: { content: json(ServicePatchSchema), required: true },
      },
      responses: {
        200: { description: "The updated service.", content: json(ServiceSchema) },
        404: problemSpec("No such service."),
        422: problemSpec("A resource id does not belong to your organization."),
        ...commonErrors,
      },
    }),
    async (c) => {
      const service = await updateService(
        deps.db,
        c.var.auth.organizationId,
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return c.json(serializeService(service), 200);
    },
  );
}

function assertCatalogInput(
  timezone: string | undefined,
  hours: { weekday: number; opensAt: string; closesAt: string }[] | undefined,
) {
  if (timezone !== undefined && !isValidTimeZone(timezone)) {
    throw problems.validation([{ path: "timezone", message: `Unknown IANA time zone "${timezone}".` }]);
  }
  const problem = hours ? validateOpeningHours(hours) : null;
  if (problem) throw problems.validation([{ path: "openingHours", message: problem }]);
}
