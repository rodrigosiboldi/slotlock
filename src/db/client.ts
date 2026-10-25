import { SQL } from "bun";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type Schema = typeof schema;

/** Driver-agnostic handle: Bun.sql in production, PGlite in tests. */
export type Database = PgDatabase<PgQueryResultHKT, Schema>;
export type Transaction = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
/** Anything queries can run on: the database itself or an open transaction. */
export type Executor = Database | Transaction;

export interface DatabaseHandle {
  db: Database;
  close(): Promise<void>;
}

/**
 * Bun's built-in Postgres client behind Drizzle. Prepared statements are off because serverless
 * deployments go through a transaction-mode pooler (Neon's PgBouncer), where named statements
 * cannot follow a client from one server connection to the next.
 */
export function connectDatabase(url: string, options: { maxConnections?: number } = {}): DatabaseHandle {
  const client = new SQL({
    url,
    max: options.maxConnections ?? 10,
    idleTimeout: 20,
    connectionTimeout: 10,
    prepare: false,
  });
  return {
    db: drizzle({ client, schema }) as unknown as Database,
    close: () => client.close(),
  };
}

/** The SQLSTATE behind an error, looking through Drizzle's wrapper and both drivers' shapes. */
export function sqlState(error: unknown): { code: string; constraint?: string } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const candidate = current as Error & { code?: unknown; errno?: unknown; constraint?: unknown };
    const code = [candidate.errno, candidate.code].find(
      (value): value is string => typeof value === "string" && /^[0-9A-Z]{5}$/.test(value),
    );
    if (code) {
      return { code, ...(typeof candidate.constraint === "string" ? { constraint: candidate.constraint } : {}) };
    }
    current = candidate.cause;
  }
  return null;
}

export const SQLSTATE = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  exclusionViolation: "23P01",
} as const;
