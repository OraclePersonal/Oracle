/**
 * Simple in-memory cache for tool operations
 * Auto-invalidates after TTL (default 5min)
 */
export class ToolCache {
  private store = new Map<string, { value: any; expiresAt: number }>();
  private readonly defaultTTL = 5 * 60 * 1000; // 5 minutes

  set(key: string, value: any, ttlMs?: number): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTTL),
    });
  }

  get<T = any>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async getOrCompute<T = any>(
    key: string,
    compute: () => Promise<T>,
    ttlMs?: number
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;

    const result = await compute();
    this.set(key, result, ttlMs);
    return result;
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  invalidatePattern(pattern: string | RegExp): number {
    const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;
    let count = 0;
    for (const key of this.store.keys()) {
      if (regex.test(key)) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  clear(): void {
    this.store.clear();
  }

  stats(): { size: number; expired: number } {
    let expired = 0;
    for (const [, entry] of this.store) {
      if (Date.now() > entry.expiresAt) expired++;
    }
    return { size: this.store.size, expired };
  }
}
