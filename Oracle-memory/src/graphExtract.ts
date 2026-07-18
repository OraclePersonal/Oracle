/**
 * Pure, storage-agnostic knowledge-graph extraction helpers.
 *
 * Shared by the file-backed `EntityGraph` (entity.ts) and the SQLite-backed
 * `SqliteGraph` (graphStore.ts) so entity typing, canonicalization, and
 * directional relation inference have exactly one implementation.
 */

/** Entity category */
export type EntityType = "person" | "technology" | "project" | "concept" | "tool";

/** Known technology/tool keywords for entity typing (lowercased). */
export const TECH_KEYWORDS = new Set([
  "typescript", "javascript", "python", "rust", "go", "java", "c++", "c#",
  "react", "vue", "angular", "svelte", "node", "deno", "bun",
  "express", "next", "nuxt", "nest", "fastify", "hono",
  "postgres", "mysql", "sqlite", "mongodb", "redis", "elasticsearch",
  "docker", "kubernetes", "aws", "gcp", "azure", "terraform",
  "graphql", "rest", "grpc", "websocket", "mcp", "json-rpc",
  "git", "github", "ci/cd", "eslint", "prettier", "biome", "vitest",
  "jwt", "oauth", "openai", "anthropic", "transformers", "vectra",
  "linux", "windows", "macos", "bash", "zsh", "powershell",
]);

/** Canonical display forms, keyed by normalized (lowercased) name. */
export const CANONICAL: Record<string, string> = {
  typescript: "TypeScript", javascript: "JavaScript", nodejs: "Node", node: "Node",
  postgres: "PostgreSQL", postgresql: "PostgreSQL", mysql: "MySQL", sqlite: "SQLite",
  mongodb: "MongoDB", redis: "Redis", graphql: "GraphQL", rest: "REST", grpc: "gRPC",
  jwt: "JWT", oauth: "OAuth", docker: "Docker", kubernetes: "Kubernetes",
  eslint: "ESLint", github: "GitHub", openai: "OpenAI", anthropic: "Anthropic",
  express: "Express", mcp: "MCP",
};

/** Relation connectives searched for in the text between two entities. */
const RELATION_CONNECTIVES: { match: RegExp; relation: string }[] = [
  { match: /\bmigrat|\bupgrad|\bport(?:ed|ing)?\b|\bmov(?:ed|ing)\s+(?:from|to)\b/i, relation: "migrates" },
  { match: /\bdepends?\s+on\b|\brequires?\b|\bneeds?\b/i, relation: "depends_on" },
  { match: /\bimplement|\bbuilt\s+(?:with|on|using)\b|\bwritten\s+in\b|\bpowered\s+by\b/i, relation: "implements" },
  { match: /\buses?\b|\busing\b|\bwith\b|\bvia\b|\bcalls?\b/i, relation: "uses" },
  { match: /\bfor\b|\bin\b|\bon\b|\band\b/i, relation: "related_to" },
];

const STOP_WORDS = new Set([
  "the", "this", "that", "these", "those", "what", "which", "who", "whom",
  "when", "where", "why", "how", "all", "each", "every", "both", "few",
  "more", "most", "other", "some", "such", "no", "nor", "not", "only",
  "own", "same", "so", "than", "too", "very", "just", "because", "but",
  "and", "or", "if", "while", "although", "about", "into", "through",
  "during", "before", "after", "above", "below", "between", "out",
  "off", "over", "under", "again", "further", "then", "once", "here",
  "there", "errors", "error", "issue", "issues", "fix", "fixed",
  "using", "used", "use", "also", "can", "will", "may", "would",
]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Canonical display name for an entity (collapses case/spelling variants). */
export function canonical(name: string): string {
  const norm = name.trim().toLowerCase();
  return CANONICAL[norm] ?? name.trim();
}

/** Guess entity type from name shape. */
export function guessType(name: string): EntityType {
  const lower = name.toLowerCase();
  if (TECH_KEYWORDS.has(lower) || CANONICAL[lower]) return "technology";
  if (lower.endsWith(".js") || lower.endsWith(".ts") || lower.endsWith(".py")) return "technology";
  if (/^[A-Z][a-z]+[A-Z]/.test(name)) return "technology"; // camelCase → likely tech
  if (/^[A-Z][a-z]+(\s+[A-Z][a-z]+)+$/.test(name)) return "project";
  return "concept";
}

/** Extract named entities from content text. Returns canonical [name, type] tuples. */
export function extractEntities(content: string, tags: string[]): [string, EntityType][] {
  const entities: Map<string, EntityType> = new Map();
  const add = (raw: string, type: EntityType) => {
    const name = canonical(raw);
    if (!entities.has(name)) entities.set(name, type);
  };

  for (const tag of tags) add(tag, guessType(tag));

  const capitalPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = capitalPattern.exec(content)) !== null) {
    const name = match[1];
    if (name.length > 2 && !STOP_WORDS.has(name.toLowerCase())) add(name, guessType(name));
  }

  const singlePattern = /\b([A-Z][a-z]{2,})\b/g;
  while ((match = singlePattern.exec(content)) !== null) {
    const name = match[1];
    if (!STOP_WORDS.has(name.toLowerCase())) add(name, guessType(name));
  }

  const acronymPattern = /\b([A-Z]{2,6})\b/g;
  while ((match = acronymPattern.exec(content)) !== null) {
    const name = match[1];
    if (!STOP_WORDS.has(name.toLowerCase())) add(name, guessType(name));
  }

  for (const keyword of [...TECH_KEYWORDS, ...Object.keys(CANONICAL)]) {
    const origMatch = new RegExp(`\\b${escapeRe(keyword)}\\b`, "i").exec(content);
    if (origMatch) add(origMatch[0], "technology");
  }

  return Array.from(entities.entries());
}

/** Word-boundary-aware first index of an entity name in text (or -1). */
export function firstIndexOf(content: string, name: string): number {
  const m = new RegExp(`\\b${escapeRe(name)}\\b`, "i").exec(content);
  return m ? m.index : -1;
}

/**
 * Infer the directional relation between two entities from the text between
 * them. Direction follows textual order; the relation label comes from the
 * connective in the gap. Falls back to "related_to" for pure co-occurrence.
 */
export function inferRelation(content: string, aRaw: string, bRaw: string): { from: string; to: string; relation: string } {
  const a = canonical(aRaw);
  const b = canonical(bRaw);
  const ia = firstIndexOf(content, a);
  const ib = firstIndexOf(content, b);

  let from = a, to = b, lo = ia, hi = ib;
  if (ia >= 0 && ib >= 0 && ib < ia) { from = b; to = a; lo = ib; hi = ia; }

  let relation = "related_to";
  if (lo >= 0 && hi >= 0 && hi > lo) {
    const gap = content.slice(lo, hi);
    for (const conn of RELATION_CONNECTIVES) {
      if (conn.match.test(gap)) { relation = conn.relation; break; }
    }
  }
  return { from, to, relation };
}
