/**
 * Simple structured logger with levels and request-id tracing.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const ENABLED = (process.env.ORACLE_MEMORY_LOG_LEVEL ?? process.env.AGOYA_LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
const THRESHOLD = LEVELS[ENABLED] ?? 1;

let requestId = "";

export function setRequestId(id: string): void {
  requestId = id;
}

function log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < THRESHOLD) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(requestId ? { req: requestId } : {}),
    ...meta,
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
  setRequestId,
};
