import { and, eq, isNull } from "drizzle-orm";
import { type AuthContext, type Deps, PUBLISHABLE_SCOPES, SCOPES, type Scope } from "../context";
import type { Executor } from "../db/client";
import { type ApiKeyKind, apiKeys, organizations } from "../db/schema";
import { randomToken, sha256Hex, uuidv7 } from "../lib/crypto";

const KEY_PREFIX: Record<ApiKeyKind, string> = { secret: "sl_sk_", publishable: "sl_pk_" };
const SHOWN_PREFIX_LENGTH = 12;
const LAST_USED_RESOLUTION_MS = 60_000;
const lastUsedWrites = new Map<string, number>();

export interface IssuedKey {
  id: string;
  /** The full key. Returned once, at creation; only its hash is stored. */
  key: string;
  prefix: string;
  kind: ApiKeyKind;
  scopes: Scope[];
}

export async function issueApiKey(
  db: Executor,
  input: { organizationId: string; name: string; kind: ApiKeyKind; scopes?: Scope[] },
): Promise<IssuedKey> {
  const key = `${KEY_PREFIX[input.kind]}${randomToken(24)}`;
  const scopes = input.kind === "publishable" ? [...PUBLISHABLE_SCOPES] : (input.scopes ?? [...SCOPES]);
  const id = uuidv7();
  await db.insert(apiKeys).values({
    id,
    organizationId: input.organizationId,
    name: input.name,
    kind: input.kind,
    prefix: key.slice(0, SHOWN_PREFIX_LENGTH),
    keyHash: sha256Hex(key),
    scopes,
  });
  return { id, key, prefix: key.slice(0, SHOWN_PREFIX_LENGTH), kind: input.kind, scopes };
}

/** Resolves a presented key to its organization and scopes, or null if unknown or revoked. */
export async function authenticateKey(
  deps: Pick<Deps, "db" | "clock" | "background">,
  presented: string,
): Promise<AuthContext | null> {
  if (!presented.startsWith("sl_sk_") && !presented.startsWith("sl_pk_")) return null;
  const [row] = await deps.db
    .select({
      id: apiKeys.id,
      kind: apiKeys.kind,
      scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt,
      organizationId: organizations.id,
      timezone: organizations.timezone,
    })
    .from(apiKeys)
    .innerJoin(organizations, eq(organizations.id, apiKeys.organizationId))
    .where(and(eq(apiKeys.keyHash, sha256Hex(presented)), isNull(apiKeys.revokedAt)))
    .limit(1);
  if (!row) return null;

  // Recording use on every request would turn reads into writes on one hot row; once a minute
  // per process is plenty (a burst of requests all read the same stale value, so remember here).
  const now = new Date(deps.clock.now().epochMilliseconds);
  const lastWrite = Math.max(row.lastUsedAt?.getTime() ?? 0, lastUsedWrites.get(row.id) ?? 0);
  if (now.getTime() - lastWrite > LAST_USED_RESOLUTION_MS) {
    lastUsedWrites.set(row.id, now.getTime());
    deps.background(deps.db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.id)));
  }
  return {
    organizationId: row.organizationId,
    timezone: row.timezone,
    keyId: row.id,
    kind: row.kind,
    scopes: new Set(row.scopes.filter((scope): scope is Scope => (SCOPES as readonly string[]).includes(scope))),
  };
}
