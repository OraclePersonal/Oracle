import type { MemoryStoreEntry } from "./adapter.js";

export interface DecayConfig {
  halfLifeDays: number; // Half-life of temporal memory retention in days
  minScoreThreshold: number; // Minimum score threshold before memory is flagged as stale
}

export const DEFAULT_DECAY_CONFIG: Readonly<DecayConfig> = Object.freeze({
  halfLifeDays: 30,
  minScoreThreshold: 0.1,
});

/**
 * Compute recency, access frequency, and importance score with exponential decay.
 */
export function computeDecayScore(
  entry: MemoryStoreEntry,
  now: number = Date.now(),
  config: DecayConfig = DEFAULT_DECAY_CONFIG
): number {
  const lastTime = new Date(entry.lastAccessed ?? entry.ts).getTime();
  const ageDays = Math.max(0, (now - lastTime) / 86_400_000);

  // Exponential decay based on half-life (λ = ln(2) / halfLife)
  const lambda = Math.LN2 / config.halfLifeDays;
  const decayBoost = Math.exp(-lambda * ageDays * (entry.decayRate ?? 1.0));

  // Access frequency reinforcement boost
  const accessBoost = Math.log1p(entry.accessCount ?? 0) * 0.12;

  // Importance weighting
  const importanceWeight = (entry.importance ?? 0.5) * 0.35;

  return Math.min(1.0, decayBoost * 0.4 + importanceWeight + accessBoost);
}

/**
 * Filter memories, identifying those whose decay score has fallen below threshold.
 */
export function identifyStaleMemories(
  entries: MemoryStoreEntry[],
  now: number = Date.now(),
  config: DecayConfig = DEFAULT_DECAY_CONFIG
): MemoryStoreEntry[] {
  return entries.filter((e) => !e.archived && computeDecayScore(e, now, config) < config.minScoreThreshold);
}
