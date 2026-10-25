import { lt } from "drizzle-orm";
import type { Deps } from "../context";
import { demoInbox, idempotencyKeys, rateLimits } from "../db/schema";
import { IDEMPOTENCY_TTL_HOURS } from "./idempotency";
import { dispatchDue } from "./webhooks";

/** Daily chores: expire idempotency keys and limiter rows, and sweep webhook retries that came due. */
export async function runHousekeeping(deps: Deps): Promise<Record<string, number>> {
  const now = deps.clock.now().epochMilliseconds;
  const day = 86_400_000;
  const [keys, limits, inbox] = await Promise.all([
    deps.db
      .delete(idempotencyKeys)
      .where(lt(idempotencyKeys.createdAt, new Date(now - IDEMPOTENCY_TTL_HOURS * 3_600_000)))
      .returning({ key: idempotencyKeys.key }),
    deps.db
      .delete(rateLimits)
      .where(lt(rateLimits.windowStartMs, now - day))
      .returning({ key: rateLimits.key }),
    deps.db
      .delete(demoInbox)
      .where(lt(demoInbox.receivedAt, new Date(now - day)))
      .returning({ id: demoInbox.id }),
  ]);
  let delivered = 0;
  for (let round = 0; round < 10; round++) {
    const { attempted } = await dispatchDue(deps, { limit: 50 });
    delivered += attempted;
    if (attempted < 50) break;
  }
  return {
    idempotencyKeysExpired: keys.length,
    rateLimitRowsExpired: limits.length,
    demoInboxExpired: inbox.length,
    webhookDeliveriesAttempted: delivered,
  };
}
