export type MemoryType = "fact" | "insight" | "chunk" | "working";

export interface MemoryEntry {
  /** Unique ID (timestamp-random format) */
  id: string;
  /** ISO-8601 timestamp */
  ts: string;
  /** Agent name that created this memory */
  agent: string;
  /** Memory type */
  type: MemoryType;
  /** Content body */
  content: string;
  /** Optional tags for categorization */
  tags: string[];
  /** Optional metadata side-channel */
  meta: Record<string, unknown>;
  /** Optional TTL in seconds (auto-expire after creation) */
  ttl?: number;
  /** If chunk: which session/context this came from */
  source?: string;
  /** Auto-computed importance score (0-1) for retention */
  importance?: number;
  /** If true, this entry has been archived (consolidated into another) */
  archived?: boolean;
  /** If consolidated: ID of the entry that supersedes this one */
  consolidatedBy?: string;
  /** Number of times this memory has been retrieved (get_memory, or returned in top-K recall results) */
  accessCount?: number;
  /** ISO-8601 timestamp of the most recent retrieval, if any */
  lastAccessedAt?: string;
  /** If promoted from working memory: which entry/type it was promoted from */
  promotedFrom?: { id: string; type: MemoryType };
  /** If true, this entry has been pruned for low decayed value (soft-delete, distinct from consolidation archival) */
  pruned?: boolean;
  /**
   * Computed on read (new/recent/aging/stale by creation age) — never
   * persisted to disk. Lets a consumer see at a glance whether a memory is
   * new or old without doing its own date math against `ts`.
   */
  freshness?: "new" | "recent" | "aging" | "stale";

  // ── Confidence & provenance (contamination guard) ──────────────────────
  /**
   * How much to trust this memory's *content* (0-1, default 0.7). Distinct
   * from `importance` (how much it matters): a memory can be very important
   * yet low-confidence (an unverified guess) or trivial yet certain. Feeds
   * conflict resolution — a high-confidence fact supersedes a low-confidence
   * one — and down-weights ranking so unverified memories surface last.
   */
  confidence?: number;
  /**
   * Trust in the *source* that produced this memory (0-1, default 0.5). A
   * user correction is more trustworthy than a model's own speculation.
   * Combined with `confidence` when deciding which side of a contradiction
   * wins. Provenance defense against memory poisoning.
   */
  sourceTrust?: number;

  // ── Contradiction / temporal invalidation ──────────────────────────────
  /**
   * ISO-8601 timestamp at which this fact stopped being true (Zep/Graphiti
   * style entry-level bi-temporal invalidation). Set when a newer,
   * contradicting memory supersedes it. Invalidated entries are excluded
   * from recall by default but remain auditable.
   */
  validTo?: string;
  /** ID of the newer memory that contradicted and superseded this one. */
  supersededBy?: string;
  /** IDs of older memories this entry contradicted and superseded on write. */
  supersedes?: string[];
  /**
   * IDs of memories this one is in unresolved tension with (a contradiction
   * was detected but neither side clearly won on confidence). Surfaced by
   * `list_conflicts` for human/agent review rather than auto-resolved.
   */
  contradicts?: string[];
  /**
   * If true, this memory failed the contamination guard on write (contradicts
   * a higher-trust memory) and is quarantined: stored for audit but excluded
   * from recall until explicitly verified via `verify_memory`.
   */
  quarantined?: boolean;
}

export interface MemoryFilter {
  /** Free-text search query */
  query?: string;
  /** Filter by agent */
  agent?: string;
  /** Filter by type(s) */
  type?: MemoryType | MemoryType[];
  /** Filter by tag(s) */
  tags?: string[];
  /** Only return entries with id > since_id (cursor-based pagination) */
  sinceId?: string;
  /** Max results (default 50) */
  limit?: number;
  /** Include expired/inactive entries */
  includeExpired?: boolean;
}

export interface SearchResult {
  entry: MemoryEntry;
  score: number;
  /** Which search method matched */
  method: "bm25" | "fuzzy" | "tag" | "exact" | "vector" | "entity";
}

export interface StoreConfig {
  /** Root directory for .oracle-memory/ store (default: cwd) */
  rootDir: string;
}

export interface StoreStats {
  totalMemories: number;
  byType: Record<MemoryType, number>;
  byAgent: Record<string, number>;
  oldestMemory: string | null;
  newestMemory: string | null;
  /** New (<7d) / recent (<30d) / aging (<90d) / stale (90d+) counts by creation age */
  byFreshness: { new: number; recent: number; aging: number; stale: number };
}

export interface ServerOptions {
  rootDir?: string;
}
