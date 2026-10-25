import { and, eq, lt } from "drizzle-orm";
import type { Executor } from "../db/client";
import { idempotencyKeys } from "../db/schema";

/** Keys are honoured for 24 hours, like Stripe's. */
export const IDEMPOTENCY_TTL_HOURS = 24;

export type IdempotencyClaim =
  | { state: "claimed" }
  | { state: "replay"; status: number; body: unknown }
  | { state: "in-progress" }
  | { state: "mismatch" };

/**
 * Claims an idempotency key for a request, atomically. The first request with a key proceeds;
 * a repeat of the same request gets the stored response; a repeat while the first is still running
 * gets "in-progress"; reusing the key for a different request is refused.
 */
export async function claimKey(
  db: Executor,
  input: { organizationId: string; key: string; fingerprint: string; now: Date },
): Promise<IdempotencyClaim> {
  const expiredBefore = new Date(input.now.getTime() - IDEMPOTENCY_TTL_HOURS * 3_600_000);
  // An expired key behaves as if it had never been used.
  await db
    .delete(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.organizationId, input.organizationId),
        eq(idempotencyKeys.key, input.key),
        lt(idempotencyKeys.createdAt, expiredBefore),
      ),
    );
  const inserted = await db
    .insert(idempotencyKeys)
    .values({
      organizationId: input.organizationId,
      key: input.key,
      fingerprint: input.fingerprint,
      createdAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });
  if (inserted.length > 0) return { state: "claimed" };

  const [existing] = await db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.organizationId, input.organizationId), eq(idempotencyKeys.key, input.key)))
    .limit(1);
  if (!existing) return { state: "in-progress" }; // released between our insert and read: try again
  if (existing.fingerprint !== input.fingerprint) return { state: "mismatch" };
  if (existing.completedAt === null || existing.responseStatus === null) return { state: "in-progress" };
  return { state: "replay", status: existing.responseStatus, body: existing.responseBody };
}

export async function completeKey(
  db: Executor,
  input: { organizationId: string; key: string; status: number; body: unknown; now: Date },
): Promise<void> {
  await db
    .update(idempotencyKeys)
    .set({ responseStatus: input.status, responseBody: input.body, completedAt: input.now })
    .where(and(eq(idempotencyKeys.organizationId, input.organizationId), eq(idempotencyKeys.key, input.key)));
}

/** Frees a key after a transient failure (5xx, rate limiting) so the client can retry with it. */
export async function releaseKey(db: Executor, input: { organizationId: string; key: string }): Promise<void> {
  await db
    .delete(idempotencyKeys)
    .where(and(eq(idempotencyKeys.organizationId, input.organizationId), eq(idempotencyKeys.key, input.key)));
}
