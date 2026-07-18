/**
 * Auto-consolidation: finds similar memories and merges them.
 * No LLM — pure heuristic merging.
 */
import type { MemoryEntry, MemoryType } from "./types.js";
import { computeImportance, extractFactors } from "./importance.js";

/** Minimum Jaccard similarity for tag-based consolidation */
const TAG_SIM_THRESHOLD = 0.3;
/** Maximum age in days for auto-consolidation candidates */
const MAX_AGE_DAYS = 90;
/** Minimum importance for retention (below this → archive if consolidated) */
const MIN_IMPORTANCE = 0.25;

export interface ConsolidationResult {
  consolidated: number;        // entries merged
  created: MemoryEntry | null; // the consolidated entry
  archived: string[];          // IDs of archived originals
}

/**
 * Find and merge similar memory entries.
 * Groups entries by tag overlap, then creates a consolidated summary.
 */
export async function consolidateMemories(
  entries: MemoryEntry[],
  saveFn: (entry: MemoryEntry) => Promise<MemoryEntry>,
  archiveFn: (id: string, type: MemoryType, consolidatedBy: string) => Promise<boolean>,
): Promise<ConsolidationResult> {
  const now = new Date();
  const candidates = entries.filter((e) => {
    // Only consider non-archived, non-working memories
    if (e.archived || e.type === "working") return false;
    // Only recent enough memories
    const ageMs = now.getTime() - new Date(e.ts).getTime();
    return ageMs < MAX_AGE_DAYS * 86_400_000;
  });

  // Group by tag overlap (Jaccard similarity)
  const groups: MemoryEntry[][] = [];
  const assigned = new Set<string>();

  for (let i = 0; i < candidates.length; i++) {
    if (assigned.has(candidates[i].id)) continue;
    const group = [candidates[i]];
    assigned.add(candidates[i].id);

    for (let j = i + 1; j < candidates.length; j++) {
      if (assigned.has(candidates[j].id)) continue;
      const sim = jaccardTags(candidates[i].tags, candidates[j].tags);
      if (sim >= TAG_SIM_THRESHOLD) {
        group.push(candidates[j]);
        assigned.add(candidates[j].id);
      }
    }

    if (group.length >= 2) {
      groups.push(group);
    }
  }

  let totalConsolidated = 0;
  let lastCreated: MemoryEntry | null = null;
  const allArchived: string[] = [];

  for (const group of groups) {
    // Score each entry, keep best as base
    const scored = group.map((e) => ({
      entry: e,
      score: computeImportance(extractFactors(e, now)),
    }));
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    // If the best is below threshold, skip
    if (best.score < MIN_IMPORTANCE) continue;

    // Merge: collect all unique tags and a combined summary
    const allTags = new Set<string>();
    const segments: string[] = [];
    const agents = new Set<string>();

    for (const { entry } of scored) {
      for (const tag of entry.tags) allTags.add(tag);
      agents.add(entry.agent);
      segments.push(entry.content);
    }

    // Build consolidated content
    const mergedContent = segments
      .filter((s, i) => !segments.slice(0, i).includes(s)) // deduplicate
      .join("\n---\n");

    const consolidatedEntry: MemoryEntry = {
      id: best.entry.id, // keep the best entry's ID
      ts: best.entry.ts,
      agent: best.entry.agent, // keep best entry's agent so agent filtering still works
      type: best.entry.type,
      content: mergedContent.length > 2000
        ? mergedContent.slice(0, 2000) + "\n[...]"
        : mergedContent,
      tags: Array.from(allTags),
      meta: {
        ...best.entry.meta,
        consolidated: true,
        consolidatedFrom: scored.map((s) => s.entry.id),
        consolidatedCount: scored.length,
        consolidatedAt: now.toISOString(),
        consolidatedAgents: Array.from(agents), // store all agents in meta
      },
      importance: Math.min(1, best.score + 0.1), // slight boost
    };

    // Archive originals (except the one we're keeping as base)
    const toArchive = scored.slice(1);
    for (const { entry } of toArchive) {
      await archiveFn(entry.id, entry.type, consolidatedEntry.id);
      allArchived.push(entry.id);
    }

    // Save the consolidated entry (replaces the best one)
    if (scored[0].entry.id !== consolidatedEntry.id || scored.length > 1) {
      await saveFn(consolidatedEntry);
    }

    totalConsolidated += toArchive.length;
    lastCreated = consolidatedEntry;
  }

  return {
    consolidated: totalConsolidated,
    created: lastCreated,
    archived: allArchived,
  };
}

/**
 * Jaccard similarity between two tag sets.
 */
function jaccardTags(a: string[], b: string[]): number {
  const setA = new Set(a.map((t) => t.toLowerCase()));
  const setB = new Set(b.map((t) => t.toLowerCase()));

  let intersection = 0;
  let union = new Set([...setA, ...setB]);

  for (const tag of setA) {
    if (setB.has(tag)) intersection++;
  }

  return union.size === 0 ? 0 : intersection / union.size;
}
