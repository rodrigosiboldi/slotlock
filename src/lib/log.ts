export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

/**
 * One JSON object per line, ready for any log drain (Vercel, Datadog, Loki...).
 * Errors are flattened so their message and stack survive JSON.stringify.
 */
export function createLogger(options: { level?: LogLevel; base?: LogFields; write?: (line: string) => void }): Logger {
  const threshold = RANK[options.level ?? "info"];
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const base = options.base ?? {};

  const emit = (level: Exclude<LogLevel, "silent">, msg: string, fields?: LogFields) => {
    if (RANK[level] < threshold) return;
    const record: LogFields = { time: new Date().toISOString(), level, msg, ...base };
    if (fields) for (const [key, value] of Object.entries(fields)) record[key] = serialize(value);
    write(JSON.stringify(record));
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

function serialize(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    const extra = value as Error & { code?: unknown; errno?: unknown; detail?: unknown };
    return {
      name: value.name,
      // Wrappers (Drizzle's "Failed query: …") put the SQL first; the cause says what went wrong.
      message: value.message.slice(0, 300),
      ...(value.stack && depth === 0 ? { stack: value.stack.split("\n").slice(0, 6).join("\n") } : {}),
      ...(extra.code !== undefined ? { code: extra.code } : {}),
      ...(extra.errno !== undefined ? { errno: extra.errno } : {}),
      ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
      ...(value.cause !== undefined && depth < 3 ? { cause: serialize(value.cause, depth + 1) } : {}),
    };
  }
  return value;
}
