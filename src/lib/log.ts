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

function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack.split("\n").slice(0, 8).join("\n") } : {}),
      ...("code" in value ? { code: value.code } : {}),
    };
  }
  return value;
}
