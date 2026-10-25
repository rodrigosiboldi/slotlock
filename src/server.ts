/**
 * Standalone server (Docker, a VPS, local development): Bun.serve with a graceful shutdown that
 * stops accepting connections, lets in-flight requests and webhook dispatches finish, then closes
 * the database pool. Also runs the webhook dispatcher on an interval, which serverless cannot.
 */
import { createRuntime } from "./bootstrap";
import { mountSite } from "./http/site";
import { dispatchDue } from "./services/webhooks";

const runtime = await createRuntime();
const { app, deps } = runtime;

// The built demo page (bun run build), served the same way as on Vercel.
mountSite(app);

const server = Bun.serve({
  port: deps.config.port,
  // SSE streams send a heartbeat every 15 s; keep idle sockets open a little longer than that.
  idleTimeout: 30,
  fetch: (request, bunServer) => app.fetch(request, { server: bunServer }),
});
deps.logger.info("listening", { url: `http://localhost:${server.port}`, publicUrl: deps.config.publicUrl });

let dispatching = false;
const dispatcher = setInterval(() => {
  if (dispatching) return;
  dispatching = true;
  dispatchDue(deps)
    .catch((error) => deps.logger.error("dispatcher failed", { error }))
    .finally(() => {
      dispatching = false;
    });
}, 5_000);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  deps.logger.info("shutting down", { signal });
  clearInterval(dispatcher);
  await server.stop(false);
  await runtime.shutdown();
  deps.logger.info("bye");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
