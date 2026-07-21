export interface BM25Doc {
  id: string;
  text: string;
}

export interface BM25Result {
  id: string;
  score: number;
}

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
  "this", "that", "these", "those", "what", "which", "who", "whom",
  "about", "up",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Lightweight BM25 ranking, no external dependencies. Scores a corpus of
 * {id, text} documents against a query and returns ids sorted by relevance.
 */
export function bm25Search(docs: BM25Doc[], query: string, limit = 20): BM25Result[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || docs.length === 0) return [];

  const k1 = 1.5;
  const b = 0.75;
  const N = docs.length;

  const docTokens = new Map<string, string[]>();
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    docTokens.set(doc.id, tokens);
    totalLen += tokens.length;
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const avgDocLen = totalLen / N || 1;

  const results: BM25Result[] = [];
  for (const doc of docs) {
    const tokens = docTokens.get(doc.id) ?? [];
    const docLen = tokens.length;
    let score = 0;
    for (const qt of queryTokens) {
      const tf = tokens.filter((t) => t === qt).length;
      if (tf === 0) continue;
      const docFreq = df.get(qt) ?? 0;
      const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);
      const numerator = tf * (k1 + 1);
      const denominator = tf + k1 * (1 - b + b * (docLen / avgDocLen));
      score += idf * (numerator / denominator);
    }
    if (score > 0) results.push({ id: doc.id, score });
  }

  // Fallback: plain substring match if BM25 (which requires token overlap
  // after stop-word filtering) finds nothing — short/unusual queries like
  // an identifier or acronym often have no BM25 signal at all.
  if (results.length === 0) {
    const q = query.toLowerCase();
    for (const doc of docs) {
      if (doc.text.toLowerCase().includes(q)) results.push({ id: doc.id, score: 0.1 });
    }
  }

  return results.sort((a, b2) => b2.score - a.score).slice(0, limit);
}
