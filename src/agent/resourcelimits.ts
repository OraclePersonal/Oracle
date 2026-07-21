/**
 * Resource limits for tool execution: timeout and output cap.
 * Prevents runaway tools from consuming excessive resources.
 */

export interface ResourceLimits {
  timeoutMs: number;
  maxOutputBytes: number;
}

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  timeoutMs: 30_000, // 30 seconds
  maxOutputBytes: 100_000, // 100 KB
};

export const EXTERNAL_MCP_RESOURCE_LIMITS: ResourceLimits = {
  timeoutMs: 30_000, // 30 seconds default
  maxOutputBytes: 100_000, // 100 KB
};

/**
 * Execute a promise with a timeout.
 * Throws if execution exceeds the timeout.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Execution timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

/**
 * Truncate a string to a maximum byte size.
 * Returns the truncated string and indicates if it was truncated.
 */
export function truncateOutput(text: string, maxBytes: number): [string, boolean] {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return [text, false];

  // Binary search to find the longest prefix that fits
  let low = 0, high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  const truncated = text.slice(0, low);
  const suffix = `\n\n[... output truncated after ${maxBytes} bytes]`;
  return [truncated + suffix, true];
}
