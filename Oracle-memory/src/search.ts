import { type MemoryEntry, type MemoryFilter, type SearchResult } from "./types.js";

/**
 * BM25-based keyword search for memory entries.
 * Lightweight, no external dependencies.
 */
export function searchEntries(
  entries: MemoryEntry[],
  filter: MemoryFilter,
): SearchResult[] {
  const query = filter.query?.toLowerCase().trim();
  const results: SearchResult[] = [];

  // Pre-filter by type/agent/tags
  let filtered = entries;
  if (filter.type) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    filtered = filtered.filter((e) => types.includes(e.type));
  }
  if (filter.agent) {
    filtered = filtered.filter((e) => e.agent === filter.agent);
  }
  if (filter.tags && filter.tags.length > 0) {
    filtered = filtered.filter((e) =>
      filter.tags!.some((t) => e.tags.includes(t)),
    );
  }
  if (filter.sinceId) {
    filtered = filtered.filter((e) => e.id > filter.sinceId!);
  }

  if (!query) {
    // No query: return all filtered by recency
    const limit = filter.limit ?? 50;
    filtered.sort((a, b) => b.ts.localeCompare(a.ts));
    return filtered.slice(0, limit).map((e) => ({
      entry: e,
      score: 1,
      method: "exact" as const,
    }));
  }

  // Tokenize query
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return [];
  }

  // BM25 parameters
  const k1 = 1.5;
  const b = 0.75;

  // Corpus stats
  const N = filtered.length;
  const avgDocLen =
    N > 0
      ? filtered.reduce((sum, e) => sum + tokenize(e.content + " " + e.tags.join(" ")).length, 0) / N
      : 1;

  // Build document frequencies
  const df: Map<string, number> = new Map();
  const docTokens: Map<string, string[]> = new Map();
  for (const entry of filtered) {
    const tokens = tokenize(entry.content + " " + entry.tags.join(" "));
    docTokens.set(entry.id, tokens);
    const uniqueTokens = new Set(tokens);
    for (const t of uniqueTokens) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }

  // Score each document
  for (const entry of filtered) {
    const tokens = docTokens.get(entry.id) ?? [];
    const docLen = tokens.length;
    let score = 0;

    for (const qt of queryTokens) {
      const tf = tokens.filter((t) => t === qt).length;
      if (tf === 0) continue;
      const idf = Math.log((N - (df.get(qt) ?? 0) + 0.5) / ((df.get(qt) ?? 0) + 0.5) + 1);
      const numerator = tf * (k1 + 1);
      const denominator = tf + k1 * (1 - b + b * (docLen / avgDocLen));
      score += idf * (numerator / denominator);
    }

    if (score > 0) {
      results.push({ entry, score, method: "bm25" });
    }
  }

  // Also add tag-exact matches with boosted score
  const queryLower = query;
  for (const entry of filtered) {
    const hasTagMatch = entry.tags.some((t) => {
      const tl = t.toLowerCase();
      return tl === queryLower || tl.includes(queryLower);
    });
    if (hasTagMatch) {
      const existing = results.find((r) => r.entry.id === entry.id);
      if (existing) {
        existing.score += 0.5;
        existing.method = existing.score > 0.6 ? "bm25" : "tag";
      } else {
        results.push({ entry, score: 0.5, method: "tag" });
      }
    }
  }

  // If BM25 returned nothing, fall back to fuzzy substring match.
  // Reuse the same tokenizer as BM25 (stop words + length>1 filtered out) —
  // matching raw, untokenized query words let trivial words like "i" or
  // "and" false-positive against nearly any content ("i" is a substring of
  // "unit", "live", "vitest"; "and" a literal hit in almost any sentence),
  // injecting noise that can outrank genuinely relevant results once fused
  // with vector search's RRF score.
  if (results.length === 0 && queryTokens.length > 0) {
    for (const entry of filtered) {
      const content = (entry.content + " " + entry.tags.join(" ")).toLowerCase();
      const matchCount = queryTokens.filter((qt) => content.includes(qt)).length;
      if (matchCount > 0) {
        const score = matchCount / queryTokens.length;
        results.push({ entry, score, method: "fuzzy" });
      }
    }
  }

  // Sort by score descending, then by recency
  results.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return b.entry.ts.localeCompare(a.entry.ts);
  });

  const limit = filter.limit ?? 50;
  return results.slice(0, limit);
}

/**
 * Simple English tokenizer: lowercase, split on non-alphanumeric, filter stop words.
 */
function tokenize(text: string): string[] {
  const STOP_WORDS = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "as", "into", "through", "during", "before", "after", "above", "below",
    "between", "out", "off", "over", "under", "again", "further", "then",
    "once", "here", "there", "when", "where", "why", "how", "all", "each",
    "every", "both", "few", "more", "most", "other", "some", "such", "no",
    "nor", "not", "only", "own", "same", "so", "than", "too", "very",
    "just", "because", "but", "and", "or", "if", "while", "although",
    "this", "that", "these", "those", "i", "me", "my", "myself", "we",
    "our", "ours", "ourselves", "you", "your", "yours", "yourself",
    "he", "him", "his", "himself", "she", "her", "hers", "herself",
    "it", "its", "itself", "they", "them", "their", "theirs", "themselves",
    "what", "which", "who", "whom", "about", "up",
  ]);

  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}
