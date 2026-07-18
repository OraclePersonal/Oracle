/**
 * Self-contained evaluation dataset for oracle-memory.
 *
 * A LongMemEval/DMR-style micro-benchmark: no network, no downloads. It seeds
 * a store with memories, then scores two things the SOTA agent-memory papers
 * care about:
 *   1. Retrieval quality — does `recall` surface the right memories? (recall@k, MRR)
 *   2. Temporal correctness — after a fact changes, does recall return the NEW
 *      value and suppress the superseded one? (this is where Zep beats Mem0)
 */

export interface SeedMemory {
  key: string; // stable handle for referencing in queries/expected sets
  type: "fact" | "insight" | "chunk";
  content: string;
  tags: string[];
  confidence?: number;
  sourceTrust?: number;
}

export interface RetrievalCase {
  query: string;
  /** keys of memories that SHOULD appear in the top results */
  relevant: string[];
}

/**
 * A temporal update: an initial fact, then a contradicting one written later.
 * After both are stored, a query must return `expectNewValueKey` and must NOT
 * return the superseded original.
 */
export interface TemporalCase {
  query: string;
  originalKey: string;   // stored first
  updateKey: string;     // stored later, contradicts original
  /** substring that identifies the current (correct) answer in recall output */
  expectSubstring: string;
  /** substring that must NOT appear (the stale answer) */
  forbidSubstring: string;
}

export const SEED: SeedMemory[] = [
  { key: "fmt", type: "fact", content: "The team uses Prettier for code formatting with 2-space indentation.", tags: ["formatting", "style", "prettier"] },
  { key: "pkg", type: "fact", content: "We use pnpm as the package manager, not npm or yarn.", tags: ["tooling", "pnpm", "packages"] },
  { key: "db", type: "fact", content: "The primary database is PostgreSQL 16 hosted on RDS.", tags: ["database", "postgresql", "infra"] },
  { key: "cache", type: "fact", content: "Redis fronts the database as a read-through cache for hot queries.", tags: ["cache", "redis", "performance"] },
  { key: "auth", type: "fact", content: "Authentication uses short-lived JWTs with a 15-minute expiry and refresh tokens.", tags: ["auth", "jwt", "security"] },
  { key: "deploy", type: "insight", content: "Blue-green deploys cut our rollback time from 20 minutes to under 1 minute.", tags: ["deploy", "devops", "reliability"] },
  { key: "slowq", type: "insight", content: "Most 'slow API' incidents traced back to missing database indexes, not app code.", tags: ["performance", "database", "debugging"] },
  { key: "test", type: "fact", content: "Tests run with Vitest; CI blocks merge on any failing test.", tags: ["testing", "vitest", "ci"] },
  { key: "region", type: "fact", content: "Production runs in AWS us-east-1 with a warm standby in us-west-2.", tags: ["infra", "aws", "regions"] },
  { key: "logging", type: "fact", content: "Structured JSON logs ship to Datadog; log level is INFO in production.", tags: ["logging", "observability", "datadog"] },
];

export const RETRIEVAL: RetrievalCase[] = [
  { query: "how do we format code", relevant: ["fmt"] },
  { query: "which package manager should I use", relevant: ["pkg"] },
  { query: "what caches the database", relevant: ["cache", "db"] },
  { query: "why were APIs slow", relevant: ["slowq"] },
  { query: "how does authentication work", relevant: ["auth"] },
  { query: "where does production run", relevant: ["region"] },
  { query: "how are tests run in CI", relevant: ["test"] },
  { query: "where do logs go", relevant: ["logging"] },
];

export const TEMPORAL: TemporalCase[] = [
  {
    query: "which package manager do we use",
    originalKey: "t_pkg_old",
    updateKey: "t_pkg_new",
    expectSubstring: "bun",
    forbidSubstring: "pnpm",
  },
  {
    query: "what is the JWT expiry",
    originalKey: "t_auth_old",
    updateKey: "t_auth_new",
    expectSubstring: "30-minute",
    forbidSubstring: "15-minute",
  },
];

/** The paired memories for the temporal cases (original written first, update second). */
export const TEMPORAL_MEMORIES: Record<string, SeedMemory> = {
  t_pkg_old: { key: "t_pkg_old", type: "fact", content: "The project uses pnpm as its package manager.", tags: ["tooling", "package-manager"], confidence: 0.6, sourceTrust: 0.4 },
  t_pkg_new: { key: "t_pkg_new", type: "fact", content: "The project now uses bun as its package manager.", tags: ["tooling", "package-manager"], confidence: 0.9, sourceTrust: 0.8 },
  t_auth_old: { key: "t_auth_old", type: "fact", content: "Authentication JWTs use a 15-minute expiry window.", tags: ["auth", "jwt"], confidence: 0.6, sourceTrust: 0.5 },
  t_auth_new: { key: "t_auth_new", type: "fact", content: "Authentication JWTs now use a 30-minute expiry window, not 15.", tags: ["auth", "jwt"], confidence: 0.9, sourceTrust: 0.8 },
};
