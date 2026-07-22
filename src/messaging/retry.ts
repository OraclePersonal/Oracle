/**
 * Exponential-backoff retry for transient I/O failures. Wraps any async
 * operation; only retries on system/network errors (EPERM, EBUSY, EIO,
 * ENOSPC, ETIMEDOUT, ECONNRESET, …) — logical errors like ENOENT or JSON
 * parse failures pass through immediately.
 *
 * ponytail: minimal — no dependency, no framework, one function.
 */

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  /** Error message substring match — only these trigger a retry. */
  transientPatterns?: RegExp;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 200,
  transientPatterns: /EPERM|EBUSY|EIO|ENOSPC|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAGAIN|EWOULDBLOCK|EMFILE|ENFILE|EPIPE|ENETDOWN|ENETUNREACH|EHOSTDOWN|EHOSTUNREACH/i,
};

function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return DEFAULT_OPTIONS.transientPatterns.test(msg);
}

/**
 * Retry `fn` up to `maxRetries` times with exponential backoff + jitter.
 * Only retries on transient system errors; re-throws immediately otherwise.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? DEFAULT_OPTIONS.maxRetries;
  const baseDelayMs = opts?.baseDelayMs ?? DEFAULT_OPTIONS.baseDelayMs;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !isTransientError(err)) throw err;
      // Exponential backoff with jitter: delay = base * 2^attempt + random(0, base)
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * baseDelayMs;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
