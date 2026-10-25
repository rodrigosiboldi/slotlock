import type { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { AppEnv, Deps } from "../../context";
import { problems } from "../../lib/problem";
import { ensureDemo, feedSince, latestFeedCursor, receiveWebhook, startRace } from "../../services/demo";
import { hit, POLICIES } from "../../services/rate-limit";
import { problemResponse } from "../errors";
import { clientIp } from "../middleware";

export const REPOSITORY_URL = "https://github.com/rodrigosiboldi/slotlock";
const FEED_SECONDS = 240;
const FEED_POLL_MS = 1_000;

/**
 * The public demo: the landing page, races, the webhook receiver and the live activity feed.
 * Everything else the page does goes through the real /v1 API with the club's publishable key.
 */
export function registerDemoRoutes(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  app.use(
    "/demo/*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) =>
        problemResponse(c, problems.unprocessable("body-too-large", "Body too large", "Keep requests under 64 KB.")),
    }),
  );

  // What the demo page needs to talk to the API as the demo club's public booking widget.
  app.get("/demo/config", async (c) => {
    const demo = await ensureDemo(deps);
    c.header("cache-control", "no-store");
    return c.json({
      name: demo.name,
      timezone: demo.timezone,
      publishableKey: demo.publishableKey,
      matchServiceId: demo.matchServiceId,
      courts: demo.courts,
      publicUrl: deps.config.publicUrl,
      repositoryUrl: REPOSITORY_URL,
    });
  });

  app.post("/demo/race", async (c) => {
    const decision = await hit(
      deps.db,
      POLICIES.raceStarts,
      clientIp(c, deps.config.trustProxy),
      deps.clock.now().epochMilliseconds,
    );
    if (!decision.allowed) return problemResponse(c, problems.rateLimited(decision.resetSeconds));
    return c.json(await startRace(deps), 201);
  });

  app.post("/demo/webhooks", async (c) => {
    const body = await c.req.text();
    const valid = await receiveWebhook(
      deps,
      {
        id: c.req.header("webhook-id") ?? null,
        timestamp: c.req.header("webhook-timestamp") ?? null,
        signature: c.req.header("webhook-signature") ?? null,
      },
      body,
    );
    return c.body(null, valid ? 204 : 401);
  });

  app.get("/demo/feed", async (c) => {
    const decision = await hit(
      deps.db,
      POLICIES.demoFeeds,
      clientIp(c, deps.config.trustProxy),
      deps.clock.now().epochMilliseconds,
    );
    if (!decision.allowed) return problemResponse(c, problems.rateLimited(decision.resetSeconds));
    let cursor = await latestFeedCursor(deps);
    c.header("cache-control", "no-store");
    c.header("x-accel-buffering", "no");
    return streamSSE(c, async (stream) => {
      let open = true;
      stream.onAbort(() => {
        open = false;
      });
      await stream.writeSSE({ event: "ready", data: "{}", retry: 1500 });
      const deadline = Date.now() + FEED_SECONDS * 1000;
      let quietSince = Date.now();
      while (open && Date.now() < deadline) {
        const { items, next } = await feedSince(deps, cursor);
        cursor = next;
        for (const item of items) await stream.writeSSE({ event: item.kind, data: JSON.stringify(item) });
        if (items.length > 0) quietSince = Date.now();
        else if (Date.now() - quietSince > 15_000) {
          await stream.write(": heartbeat\n\n");
          quietSince = Date.now();
        }
        await stream.sleep(FEED_POLL_MS);
      }
    });
  });
}
