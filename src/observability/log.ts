/**
 * Structured observability logging — JSON lines to stderr with [oracle:*] tags.
 * Each event is one line (never breaks output), grepable, and machine-parseable.
 * Disableable via ORACLE_LOG=0 to avoid overhead in production.
 */

export interface LogEvent {
  event: string;
  [key: string]: unknown;
}

function isEnabled(): boolean {
  return process.env.ORACLE_LOG !== "0";
}

function timestamp(): string {
  return new Date().toISOString();
}

/** Log a structured event to stderr with [oracle:tag] prefix. */
export function logEvent(tag: string, event: LogEvent): void {
  if (!isEnabled()) return;
  try {
    const line = JSON.stringify({
      ts: timestamp(),
      ...event,
    });
    console.error(`[oracle:${tag}] ${line}`);
  } catch {
    // logging must never break the request
  }
}

/** Agent loop lifecycle and execution. */
export function logAgent(event: "start" | "stop" | "turn" | "error" | "audit-summary", details: Record<string, unknown>): void {
  logEvent("agent", { event, ...details });
}

/** Tool execution: call, result, error. */
export function logTool(event: "call" | "result" | "error", details: Record<string, unknown>): void {
  logEvent("tool", { event, ...details });
}

/** MCP server connection, tool discovery, calls. */
export function logMcp(event: "connect" | "disconnect" | "discover" | "call" | "result" | "error", details: Record<string, unknown>): void {
  logEvent("mcp", { event, ...details });
}

/** Sandbox violations or security-relevant events. */
export function logSandbox(event: "path-escape" | "mutation-denied" | "boundary-check", details: Record<string, unknown>): void {
  logEvent("sandbox", { event, ...details });
}
