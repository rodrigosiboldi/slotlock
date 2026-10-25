import type { Context, Hono } from "hono";
import { serveStatic } from "hono/bun";

/**
 * The demo page (built into ./public by `bun run build`). Routes are registered explicitly so
 * serverless platforms that route by the app's declared paths send them to this function; the
 * CDN then keeps them: hashed assets forever, the page itself for a minute.
 */
// biome-ignore lint/suspicious/noExplicitAny: works with any Hono env
export function mountSite(app: Hono<any>, root = "./public"): void {
  const file = (options: { path: string } | { root: string }, cacheControl: string) => {
    const serve = serveStatic(options);
    return async (c: Context) => {
      const response = await serve(c, async () => {});
      if (!response) return c.notFound();
      response.headers.set("cache-control", cacheControl);
      return response;
    };
  };
  app.get("/", file({ path: `${root}/index.html` }, "public, max-age=0, s-maxage=60, stale-while-revalidate=600"));
  app.get("/assets/*", file({ root }, "public, max-age=31536000, immutable"));
  app.get("/og.png", file({ path: `${root}/og.png` }, "public, max-age=86400"));
  app.get("/favicon.svg", file({ path: `${root}/favicon.svg` }, "public, max-age=86400"));
}
