/**
 * Auto-consolidation: finds similar memory entries and merges them.
 * Stateless/pure — entries in, result out. No LLM, pure heuristic merging.
 */
import type { MemoryStoreEntry } from "./adapter.js";

/** Minimum Jaccard similarity for tag-based consolidation */
const TAG_SIM_THRESHOLD = 0.3;

/** Maximum age in days for auto-consolidation candidates */
const MAX_AGE_DAYS = 90;

/** Maximum content length for a consolidated entry (truncated with [...]) */
const MAX_CONTENT_LENGTH = 2000;

export interface ConsolidationResult {
  /** Number of entries that were merged into consolidated entries */
  consolidated: number;
  /** The last consolidated entry created, or null if none */
  created: MemoryStoreEntry | null;
  /** IDs of archived originals */
  archived: string[];
}

/**
 * Compute Jaccard similarity between two tag arrays.
 * Tags are compared case-insensitively.
 */
function jaccardTags(a: string[], b: string[]): number {
  const setA = new Set(a.map((t) => t.toLowerCase()));
  const setB = new Set(b.map((t) => t.toLowerCase()));

  let intersection = 0;
  for (const tag of setA) {
    if (setB.has(tag)) intersection++;
  }

  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection / union.size;
}

/**
 * Find and merge similar memory entries by tag overlap.
 *
 * @param entries    - All memory entries to consider for consolidation.
 * @param saveFn     - Async function to persist a consolidated entry.
 * @param archiveFn  - Async function to archive an original entry by ID.
 * @returns A ConsolidationResult describing what was merged.
 */
export async function consolidateMemories(
  entries: MemoryStoreEntry[],
  saveFn: (entry: MemoryStoreEntry) => Promise<MemoryStoreEntry>,
  archiveFn: (id: string, consolidatedBy: string) => Promise<boolean>,
): Promise<ConsolidationResult> {
  const now = new Date();

  // Filter candidates: non-archived, non-working, within max age
  const candidates = entries.filter((e) => {
    if (e.archived || e.type === "working") return false;
    const ageMs = now.getTime() - new Date(e.ts).getTime();
    return ageMs < MAX_AGE_DAYS * 86_400_000;
  });

  // Group candidates by tag overlap (Jaccard similarity)
  const groups: MemoryStoreEntry[][] = [];
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
  let lastCreated: MemoryStoreEntry | null = null;
  const allArchived: string[] = [];

  for (const group of groups) {
    // Keep the first entry as the base (best entry)
    const best = group[0];
    const rest = group.slice(1);

    // Merge: collect unique tags and deduplicate content
    const allTags = new Set<string>();
    const segments: string[] = [];
    const seenContent = new Set<string>();

    for (const entry of group) {
      for (const tag of entry.tags) {
        allTags.add(tag);
      }
      // Deduplicate identical content
      if (!seenContent.has(entry.content)) {
        seenContent.add(entry.content);
        segments.push(entry.content);
      }
    }

    // Build consolidated content
    const mergedContent = segments.join("\n---\n");
    const truncatedContent =
      mergedContent.length > MAX_CONTENT_LENGTH
        ? mergedContent.slice(0, MAX_CONTENT_LENGTH) + "\n[...]"
        : mergedContent;

    const consolidatedEntry: MemoryStoreEntry = {
      id: best.id,
      ts: best.ts,
      agent: best.agent,
      type: best.type,
      content: truncatedContent,
      tags: Array.from(allTags),
      meta: {
        ...best.meta,
        consolidated: true,
        consolidatedFrom: group.map((e) => e.id),
        consolidatedCount: group.length,
        consolidatedAt: now.toISOString(),
      },
      importance: best.importance,
      source: best.source,
      accessCount: best.accessCount,
      lastAccessed: best.lastAccessed,
      decayRate: best.decayRate,
    };

    // Archive originals (all entries in the group except the best)
    for (const entry of rest) {
      await archiveFn(entry.id, consolidatedEntry.id);
      allArchived.push(entry.id);
    }

    // Save the consolidated entry (replaces the best entry)
    await saveFn(consolidatedEntry);

    totalConsolidated += rest.length;
    lastCreated = consolidatedEntry;
  }

  return {
    consolidated: totalConsolidated,
    created: lastCreated,
    archived: allArchived,
  };
}
