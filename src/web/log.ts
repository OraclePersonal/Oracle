/**
 * Structured routing/observability log for web tools — provider chosen and
 * why, latency, and fallback chains. Written to stderr as one JSON line per
 * event so it never pollutes stdout (MCP/CLI tool output) but is still
 * grep-able ("[oracle:web]") and machine-parseable for debugging a bad
 * answer after the fact.
 */
export function logWebEvent(event: Record<string, unknown>): void {
  if (process.env.ORACLE_WEB_LOG === "0") return;
  try {
    console.error(`[oracle:web] ${JSON.stringify({ ts: new Date().toISOString(), ...event })}`);
  } catch {
    /* logging must never break the request */
  }
}
