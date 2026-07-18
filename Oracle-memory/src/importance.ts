/**
 * Automatic importance scoring for memory entries.
 * Pure heuristic — no LLM calls, no external dependencies.
 */

import type { MemoryEntry, MemoryType } from "./types.js";

export interface ImportanceFactors {
  /** How many tags (more = richer context) */
  tagCount: number;
  /** Approximate entity mentions extracted from content length + caps */
  estimatedEntityCount: number;
  /** Content length in characters */
  contentLength: number;
  /** Memory type weight */
  type: MemoryType;
  /** Days since this memory was created */
  ageDays: number;
  /** Explicit importance override (0-1) */
  explicitScore?: number;
  /** Whether agent explicitly marked it important */
  hasExplicitMark: boolean;
  /** Has source/context info */
  hasSource: boolean;
  /** How many times this memory has been retrieved */
  accessCount: number;
  /** Days since last retrieval, or ageDays if never accessed */
  daysSinceAccess: number;
}

/**
 * Compute an importance score (0.0 - 1.0) for a memory entry.
 */
export function computeImportance(factors: ImportanceFactors): number {
  // If explicitly set, trust it with slight recency adjustment
  if (factors.explicitScore !== undefined) {
    const recencyBonus = Math.max(0, 1 - factors.ageDays / 365);
    return clamp(factors.explicitScore * (0.8 + 0.2 * recencyBonus));
  }

  let score = 0.3; // baseline

  // Tag richness: more tags = more structured knowledge
  score += clamp(factors.tagCount * 0.08, 0, 0.24);

  // Entity richness: more entities = more connected knowledge
  score += clamp(factors.estimatedEntityCount * 0.04, 0, 0.16);

  // Content length: very short = low value, very long = medium-high
  if (factors.contentLength > 20) {
    score += clamp(Math.log10(factors.contentLength / 20) * 0.06, 0, 0.12);
  }

  // Memory type weight
  const typeWeights: Record<MemoryType, number> = {
    fact: 0.1,     // permanent knowledge = default high
    insight: 0.15, // lessons learned = most valuable
    chunk: 0.0,    // raw snapshots = no inherent value
    working: -0.1, // scratchpad = low value
  };
  score += typeWeights[factors.type];

  // Explicit mark (e.g., agent says "important" in content)
  if (factors.hasExplicitMark) {
    score += 0.1;
  }

  // Source context
  if (factors.hasSource) {
    score += 0.05;
  }

  // Recency-of-creation: slight decay over time (max -0.1 at 1 year)
  score -= clamp(factors.ageDays / 3650, 0, 0.1);

  // Reuse boost: memories that keep getting retrieved are proven valuable —
  // this is what lets an old-but-frequently-recalled fact outrank a recent,
  // never-touched one. Diminishing returns via log so a handful of hits is
  // enough; endless re-recall doesn't dominate the score.
  if (factors.accessCount > 0) {
    score += clamp(Math.log2(factors.accessCount + 1) * 0.06, 0, 0.18);
  }

  // Staleness-of-access: separate from creation-age decay above. A memory
  // nobody has touched in a long time (even if recently created) trends
  // toward the forgetting threshold used by pruneStaleMemories().
  score -= clamp(factors.daysSinceAccess / 1800, 0, 0.15);

  return clamp(score);
}

/**
 * Extract importance factors from a memory entry.
 */
export function extractFactors(entry: MemoryEntry, now: Date = new Date()): ImportanceFactors {
  const created = new Date(entry.ts);
  const ageMs = now.getTime() - created.getTime();
  const ageDays = Math.max(0, ageMs / 86_400_000);

  // Count capitalized words as rough entity estimate
  const capsMatches = entry.content.match(/\b[A-Z][a-z]{2,}\b/g);
  const estimatedEntityCount = capsMatches ? new Set(capsMatches).size : 0;

  // Has explicit importance marker? (words like "important", "critical", "key", "remember")
  const lower = entry.content.toLowerCase();
  const hasExplicitMark = /\b(important|critical|key insight|remember|notable|caution|warning|gotcha|never|always)\b/i.test(lower);

  const daysSinceAccess = entry.lastAccessedAt
    ? Math.max(0, (now.getTime() - new Date(entry.lastAccessedAt).getTime()) / 86_400_000)
    : ageDays;

  return {
    tagCount: entry.tags.length,
    estimatedEntityCount,
    contentLength: entry.content.length,
    type: entry.type,
    ageDays,
    explicitScore: entry.importance,
    hasExplicitMark,
    hasSource: !!entry.source,
    accessCount: entry.accessCount ?? 0,
    daysSinceAccess,
  };
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

export type Freshness = "new" | "recent" | "aging" | "stale";

/**
 * Classify a memory's age into a human/agent-legible bucket. This is the
 * explicit "is this new or old" signal — separate from importance, so a
 * consumer can distinguish "old but still ranked highly because it's
 * reused" from "old and about to be pruned" at a glance.
 */
export function classifyFreshness(ageDays: number): Freshness {
  if (ageDays < 7) return "new";
  if (ageDays < 30) return "recent";
  if (ageDays < 90) return "aging";
  return "stale";
}
