import { createApp } from "./app";
import { type Config, loadConfig } from "./config";
import type { Deps } from "./context";
import { connectDatabase } from "./db/client";
import { createLogger } from "./lib/log";
import { createMetrics } from "./lib/metrics";
import { createSecrets } from "./lib/secrets";

export interface Runtime {
  app: ReturnType<typeof createApp>;
  deps: Deps;
  /** Waits for background work (webhook dispatch) and closes the pool. */
  shutdown(): Promise<void>;
}

/**
 * Wires the production dependencies. `background` decides how work outlives a response:
 * Vercel's waitUntil in a function, a tracked promise set on the standalone server.
 */
export async function createRuntime(
  options: { config?: Config; background?: (task: Promise<unknown>) => void } = {},
): Promise<Runtime> {
  const config = options.config ?? loadConfig();
  const logger = createLogger({ level: config.logLevel, base: { service: "slotlock", version: config.version } });
  const database = connectDatabase(config.databaseUrl, { maxConnections: config.dbMaxConnections });
  const pending = new Set<Promise<unknown>>();

  const track = (task: Promise<unknown>) => {
    const guarded = Promise.resolve(task)
      .catch((error) => logger.error("background task failed", { error }))
      .finally(() => pending.delete(guarded));
    pending.add(guarded);
    return guarded;
  };

  const deps: Deps = {
    config,
    db: database.db,
    secrets: await createSecrets(config.appSecret),
    logger,
    metrics: createMetrics(),
    clock: { now: () => Temporal.Now.instant() },
    fetch: globalThis.fetch,
    background: (task) => {
      const guarded = track(task);
      options.background?.(guarded);
    },
  };

  return {
    app: createApp(deps),
    deps,
    async shutdown() {
      await Promise.allSettled([...pending]);
      await database.close();
    },
  };
}
