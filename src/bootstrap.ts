import { sql } from "drizzle-orm";
import { createApp } from "./app";
import { type Config, loadConfig } from "./config";
import type { Deps } from "./context";
import { connectDatabase, type Database } from "./db/client";
import { createLogger, type Logger } from "./lib/log";
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
  await warmUp(database.db, logger);
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

/**
 * Opens the first connection before the instance takes traffic. A cold serverless instance
 * otherwise meets its first burst with an empty pool: every request opens a connection at once,
 * the database proxy refuses part of the storm ("too many connection attempts"), and a pool with
 * no connection fails everyone waiting. With one connection up, the pool grows a connection at a
 * time while requests share the ones it has.
 */
async function warmUp(db: Database, logger: Logger): Promise<void> {
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      await db.execute(sql`select 1`);
      return;
    } catch (error) {
      logger.warn("database warm-up failed", { attempt, error });
      // Instances that start together back off apart, so their retries don't collide again.
      await new Promise((resolve) => setTimeout(resolve, Math.min(1500, 80 * 2 ** attempt) + Math.random() * 250));
    }
  }
}
