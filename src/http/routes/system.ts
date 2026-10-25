import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import type { AppEnv, Deps } from "../../context";
import { safeEqual } from "../../lib/crypto";
import { ProblemError, problems } from "../../lib/problem";
import { runHousekeeping } from "../../services/housekeeping";
import { problemSpec } from "../schemas";

const json = <T>(schema: T) => ({ "application/json": { schema } });

export function registerSystemRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: Deps,
  extra: { resetDemo?: () => Promise<unknown> },
): void {
  app.openapi(
    createRoute({
      method: "get",
      path: "/healthz",
      tags: ["System"],
      summary: "Liveness",
      description: "The process is up. Does not touch the database.",
      responses: {
        200: {
          description: "Alive.",
          content: json(
            z.object({
              status: z.literal("ok"),
              version: z.string().openapi({ example: "4f2a91c" }),
              runtime: z.string().openapi({ example: "bun 1.4.4" }),
            }),
          ),
        },
      },
    }),
    (c) => c.json({ status: "ok" as const, version: deps.config.version, runtime: `bun ${Bun.version}` }, 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/readyz",
      tags: ["System"],
      summary: "Readiness",
      description: "The database answers and the booking guarantee (the exclusion constraint) is in place.",
      responses: {
        200: {
          description: "Ready to take traffic.",
          content: json(
            z.object({
              status: z.literal("ready"),
              database: z.object({ latencyMs: z.number(), noOverlapConstraint: z.boolean() }),
            }),
          ),
        },
        503: problemSpec("Not ready."),
      },
    }),
    async (c) => {
      const started = performance.now();
      try {
        const rows = await deps.db.execute<{ present: boolean }>(
          sql`select exists (select 1 from pg_constraint where conname = 'bookings_no_overlap') as present`,
        );
        const present = Boolean(firstRow<{ present: boolean }>(rows)?.present);
        if (!present) throw new Error("bookings_no_overlap constraint missing; run the migrations");
        return c.json(
          {
            status: "ready" as const,
            database: { latencyMs: Math.round(performance.now() - started), noOverlapConstraint: present },
          },
          200,
        );
      } catch (error) {
        c.var.log.error("readiness check failed", { error });
        const detail = error instanceof Error ? error.message : "Database unavailable.";
        throw new ProblemError({ status: 503, slug: "not-ready", title: "Not ready", detail });
      }
    },
  );

  // Prometheus scrape target, behind a bearer token (and off entirely without one).
  app.get("/metrics", (c) => {
    const token = deps.config.metricsToken;
    const presented = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!token || !safeEqual(presented, token)) throw problems.notFound("Route");
    return c.text(deps.metrics.registry.render(), 200, { "content-type": "text/plain; version=0.0.4" });
  });

  // Vercel Cron calls this daily with `Authorization: Bearer $CRON_SECRET`.
  app.get("/internal/cron/daily", async (c) => {
    const secret = deps.config.cronSecret;
    const presented = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!secret || !safeEqual(presented, secret)) throw problems.unauthorized("Cron secret required.");
    const report = await runHousekeeping(deps);
    const demo = extra.resetDemo ? await extra.resetDemo() : null;
    c.var.log.info("daily housekeeping", { ...report, demo });
    return c.json({ ok: true, ...report, demo }, 200);
  });
}

/** `execute` returns rows directly with Bun.sql and as `{ rows }` with PGlite. */
export function firstRow<T>(result: unknown): T | undefined {
  if (Array.isArray(result)) return result[0] as T | undefined;
  const rows = (result as { rows?: T[] } | undefined)?.rows;
  return rows?.[0];
}
