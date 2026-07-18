import { randomBytes } from "node:crypto";
import { type MemoryEntry, type MemoryFilter, type MemoryType, type SearchResult } from "./types.js";
import { Store } from "./store.js";
import { VectorStore } from "./vectorStore.js";
import { EntityGraph } from "./entity.js";
import { SqliteGraph } from "./graphStore.js";
import { createLlmExtractor } from "./llmExtractor.js";

/** Common surface shared by the JSON (EntityGraph) and SQLite (SqliteGraph) graphs. */
type KnowledgeGraph = Pick<
  EntityGraph,
  "indexMemory" | "expandQuery" | "getMemoryIdsForEntity" | "removeMemory" | "findPath" | "getStats" | "setExtractor"
>;

export interface MemoryStoreOptions {
  /** Graph backend: "json" (file-backed, default) or "sqlite" (indexed + temporal edges). */
  graph?: "json" | "sqlite";
  /** Enable the LLM triple extractor (needs ANTHROPIC_API_KEY). Default: env ORACLE_MEMORY_LLM_GRAPH=1. */
  llmGraph?: boolean;
}
import { searchEntries } from "./search.js";
import { computeImportance, extractFactors, classifyFreshness } from "./importance.js";
import { consolidateMemories, type ConsolidationResult } from "./consolidator.js";
import {
  detectConflictsHeuristic,
  createLlmConflictDetector,
  memoryTrust,
  type ConflictDetector,
  type ConflictCandidate,
} from "./conflict.js";
import { createReflector, clusterByTags, type Reflector, type Reflection } from "./reflect.js";

/** RRF constant for hybrid search fusion */
const RRF_K = 60;

/** Minimum detector score to treat a candidate as a real contradiction. */
const CONFLICT_THRESHOLD = 0.5;
/** Trust margin required for one side of a contradiction to clearly win. */
const TRUST_MARGIN = 0.05;

/** How a detected contradiction was resolved on write. */
export interface ResolvedConflict {
  /** ID of the pre-existing memory involved. */
  id: string;
  /** supersede = the new memory won, old invalidated; quarantine = new memory
   *  lost and is held back from recall; flag = tie, both kept for review. */
  action: "supersede" | "quarantine" | "flag";
  reason: string;
  score: number;
}

/**
 * Generate a chronologically sortable unique ID.
 * Format: YYYYMMDD-HHMMSS-uuuuuu-XXXX (same format as agora messages)
 */
function generateId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const micros = String(now.getMilliseconds()).padStart(3, "0") + "000";
  // 6 bytes (48 bits) of randomness to avoid collisions in the same millisecond
  const rand = randomBytes(6).toString("hex");
  return `${date}-${time}-${micros}-${rand}`;
}

export class MemoryStore {
  private store: Store;
  private vectorStore: VectorStore | null;
  private entityGraph: KnowledgeGraph;
  private useVectors: boolean;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  /** Conflict detectors run on write; heuristic is always present, LLM optional. */
  private conflictDetectors: ConflictDetector[] = [];
  /** Optional LLM reflector for insight synthesis (null without an API key). */
  private reflector: Reflector | null = null;

  constructor(rootDir: string, enableVectors: boolean = true, opts: MemoryStoreOptions = {}) {
    this.store = new Store(rootDir);
    this.useVectors = enableVectors;
    this.vectorStore = enableVectors ? new VectorStore(rootDir) : null;
    this.entityGraph = opts.graph === "sqlite" ? new SqliteGraph(rootDir) : new EntityGraph(rootDir);

    // Heuristic contradiction detection is always on — deterministic, no network.
    this.conflictDetectors.push(async (incoming, existing) => detectConflictsHeuristic(incoming, existing));

    // Wire the LLM triple extractor, conflict detector, and reflector when
    // explicitly enabled (or via env) and a key is present.
    const llmEnabled = opts.llmGraph ?? process.env.ORACLE_MEMORY_LLM_GRAPH === "1";
    if (llmEnabled) {
      const extractor = createLlmExtractor();
      if (extractor) this.entityGraph.setExtractor(extractor);
      const llmConflict = createLlmConflictDetector();
      if (llmConflict) this.conflictDetectors.push(llmConflict);
      this.reflector = createReflector();
    }
  }

  /**
   * Save a memory entry. If vectors are enabled, also indexes for semantic search.
   */
  async remember(
    agent: string,
    type: MemoryType,
    content: string,
    opts?: {
      tags?: string[];
      meta?: Record<string, unknown>;
      ttl?: number;
      source?: string;
      importance?: number;
      /** Content trust 0-1 (default 0.7). Low values surface last and lose contradictions. */
      confidence?: number;
      /** Source trust 0-1 (default 0.5). A user correction should outrank a model guess. */
      sourceTrust?: number;
      /** Run contradiction detection against existing memories (default true for fact/insight). */
      checkConflicts?: boolean;
    },
  ): Promise<MemoryEntry> {
    const id = generateId();
    const ts = new Date().toISOString();

    // Compute importance heuristically
    const factors = extractFactors({
      id, ts, agent, type, content,
      tags: opts?.tags ?? [],
      meta: opts?.meta ?? {},
      ttl: opts?.ttl,
      source: opts?.source,
      importance: opts?.importance,
    });
    const importance = opts?.importance ?? computeImportance(factors);

    const entry: MemoryEntry = {
      id,
      ts,
      agent,
      type,
      content,
      tags: opts?.tags ?? [],
      meta: opts?.meta ?? {},
      ttl: opts?.ttl,
      source: opts?.source,
      importance,
      confidence: opts?.confidence ?? 0.7,
      sourceTrust: opts?.sourceTrust ?? 0.5,
    };

    // Contradiction detection + resolution. Only durable, factual memories
    // are checked by default — working scratchpad and raw chunks are expected
    // to churn and shouldn't invalidate each other.
    const shouldCheck = opts?.checkConflicts ?? (type === "fact" || type === "insight");
    let resolved: ResolvedConflict[] = [];
    if (shouldCheck) {
      resolved = await this.resolveConflicts(entry);
      if (resolved.length > 0) {
        entry.meta = { ...entry.meta, conflictsResolved: resolved };
      }
    }

    await this.store.createEntry(entry);

    // Quarantined memories are stored for audit but kept out of the semantic
    // and graph indices so they can't contaminate recall until verified.
    if (!entry.quarantined) {
      if (this.vectorStore) {
        this.vectorStore.addMemory(entry.id, entry.type, entry.agent, entry.content, entry.tags).catch(() => {});
      }
      this.entityGraph.indexMemory(entry.id, entry.content, entry.tags).catch(() => {});
    }

    return entry;
  }

  /**
   * Detect contradictions between a freshly-built entry and existing durable
   * memories, then resolve each by trust arbitration. Mutates `entry` (may set
   * supersedes/contradicts/quarantined) and persists the affected existing
   * memories (validTo/supersededBy/contradicts). Returns a per-conflict log.
   */
  private async resolveConflicts(entry: MemoryEntry): Promise<ResolvedConflict[]> {
    // Only durable, non-invalidated memories are contradiction candidates.
    const existing = (await this.store.listEntries())
      .filter((e) => (e.type === "fact" || e.type === "insight") && e.id !== entry.id)
      .filter((e) => !e.archived && !e.pruned && !e.validTo && !e.quarantined);
    if (existing.length === 0) return [];

    // Run every detector and merge by entry id, keeping the strongest score.
    const merged = new Map<string, ConflictCandidate>();
    for (const detect of this.conflictDetectors) {
      let found: ConflictCandidate[] = [];
      try {
        found = await detect({ content: entry.content, tags: entry.tags }, existing);
      } catch {
        found = [];
      }
      for (const c of found) {
        const prev = merged.get(c.entry.id);
        if (!prev || c.score > prev.score) merged.set(c.entry.id, c);
      }
    }

    const now = new Date().toISOString();
    const resolved: ResolvedConflict[] = [];
    const trustNew = memoryTrust(entry);

    for (const c of merged.values()) {
      if (c.score < CONFLICT_THRESHOLD) continue;
      const old = c.entry;
      const trustOld = memoryTrust(old);

      if (trustNew >= trustOld + TRUST_MARGIN) {
        // New memory clearly wins → temporally invalidate the old one.
        old.validTo = now;
        old.supersededBy = entry.id;
        await this.store.updateEntry(old);
        this.entityGraph.removeMemory(old.id).catch(() => {});
        if (this.vectorStore) this.vectorStore.removeMemory(old.id).catch(() => {});
        entry.supersedes = [...(entry.supersedes ?? []), old.id];
        resolved.push({ id: old.id, action: "supersede", reason: c.reason, score: c.score });
      } else if (trustOld >= trustNew + TRUST_MARGIN) {
        // Existing memory is more trustworthy → quarantine the newcomer.
        entry.quarantined = true;
        entry.contradicts = [...(entry.contradicts ?? []), old.id];
        resolved.push({ id: old.id, action: "quarantine", reason: c.reason, score: c.score });
      } else {
        // Genuine tie → flag both for review rather than guessing.
        entry.contradicts = [...(entry.contradicts ?? []), old.id];
        old.contradicts = [...(old.contradicts ?? []), entry.id];
        await this.store.updateEntry(old);
        resolved.push({ id: old.id, action: "flag", reason: c.reason, score: c.score });
      }
    }

    return resolved;
  }

  /**
   * Attach a computed (not persisted) freshness bucket so callers can tell
   * new memories from old ones without doing their own date math on `ts`.
   */
  private annotateFreshness(entry: MemoryEntry, now: Date = new Date()): MemoryEntry {
    const ageDays = Math.max(0, (now.getTime() - new Date(entry.ts).getTime()) / 86_400_000);
    return { ...entry, freshness: classifyFreshness(ageDays) };
  }

  /**
   * Retrieve a single memory by id and type. Counts as a real access —
   * bumps accessCount/lastAccessedAt so decay-aware importance scoring
   * (see importance.ts) can distinguish "old but still used" from "stale".
   */
  async getMemory(id: string, type: MemoryType): Promise<MemoryEntry | null> {
    const entry = await this.store.getEntry(id, type);
    if (!entry) return null;
    const touched = await this.store.touch(id, type);
    return this.annotateFreshness(touched ?? entry);
  }

  /**
   * Update an existing memory's mutable fields (content, tags, importance, meta, ttl).
   * Re-indexes in vector store and entity graph.
   */
  async updateMemory(
    id: string,
    type: MemoryType,
    updates: { content?: string; tags?: string[]; importance?: number; meta?: Record<string, unknown>; ttl?: number },
  ): Promise<MemoryEntry | null> {
    const entry = await this.store.getEntry(id, type);
    if (!entry) return null;

    if (updates.content !== undefined) entry.content = updates.content;
    if (updates.tags !== undefined) entry.tags = updates.tags;
    if (updates.importance !== undefined) entry.importance = updates.importance;
    if (updates.meta !== undefined) entry.meta = { ...entry.meta, ...updates.meta };
    if (updates.ttl !== undefined) entry.ttl = updates.ttl;

    await this.store.updateEntry(entry);

    // Re-index in vector store
    if (this.vectorStore) {
      this.vectorStore.removeMemory(id).catch(() => {});
      this.vectorStore.addMemory(entry.id, entry.type, entry.agent, entry.content, entry.tags).catch(() => {});
    }
    // Re-index in entity graph
    this.entityGraph.removeMemory(id).catch(() => {});
    this.entityGraph.indexMemory(entry.id, entry.content, entry.tags).catch(() => {});

    return entry;
  }

  /**
   * Start background TTL cleanup that removes expired entries every N minutes.
   */
  startTTLCleanup(intervalMs: number = 300_000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(async () => {
      try {
        const all = await this.store.listEntries();
        const now = Date.now();
        for (const e of all) {
          if (!e.ttl) continue;
          if (now - new Date(e.ts).getTime() > e.ttl * 1000) {
            await this.forget(e.id, e.type);
          }
        }
      } catch {
        // swallow — cleanup is best-effort
      }
    }, intervalMs);
    this.cleanupTimer.unref();
  }

  /** Stop background TTL cleanup. */
  stopTTLCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * List/filter memories.
   */
  async listMemories(filter: MemoryFilter): Promise<MemoryEntry[]> {
    let entries = await this.store.listEntries(filter.type as MemoryType | undefined);
    // Exclude archived/pruned by default
    if (!filter.includeExpired) {
      entries = entries.filter((e) => !e.archived && !e.pruned && !e.quarantined && !e.validTo);

      // Apply TTL filter BEFORE searchEntries so that the limit applies correctly
      const now = Date.now();
      entries = entries.filter((e) => {
        if (!e.ttl) return true;
        return now - new Date(e.ts).getTime() <= e.ttl * 1000;
      });
    }

    const results = searchEntries(entries, filter);
    return results.map((r) => this.annotateFreshness(r.entry));
  }

  /**
   * Search memories with hybrid ranking: BM25 + vector semantic (when available).
   */
  async searchMemories(filter: MemoryFilter): Promise<SearchResult[]> {
    let entries = (filter.type && !Array.isArray(filter.type))
      ? await this.store.listEntries(filter.type)
      : await this.store.listEntries();
    // Exclude archived/pruned by default
    if (!filter.includeExpired) {
      entries = entries.filter((e) => !e.archived && !e.pruned && !e.quarantined && !e.validTo);
    }
    const bm25Results = searchEntries(entries, filter);

    // Filter expired from BM25
    const now = Date.now();
    let bm25Valid = bm25Results.filter((r) => {
      if (r.entry.ttl && !filter.includeExpired) {
        const created = new Date(r.entry.ts).getTime();
        return now - created <= r.entry.ttl * 1000;
      }
      return true;
    });

    // No query? Just return sorted by recency
    if (!filter.query) {
      return bm25Valid;
    }

    // Entity graph expansion: find related entities and boost their memories
    const boostedIds = new Set<string>();
    try {
      const expansion = await this.entityGraph.expandQuery(filter.query);
      // Get memory IDs for all related entities
      for (const related of expansion.related) {
        const ids = await this.entityGraph.getMemoryIdsForEntity(related);
        for (const id of ids) boostedIds.add(id);
      }
    } catch {
      // Entity boost is optional
    }

    // Apply entity boost to BM25 results (preserve original match method)
    let boosted = false;
    const bm25MatchedIds = new Set(bm25Valid.map((r) => r.entry.id));
    for (const result of bm25Valid) {
      if (boostedIds.has(result.entry.id)) {
        result.score += 0.3; // entity relationship boost
        boosted = true;
      }
    }

    // A memory can be entity-related to the query without sharing a single
    // BM25/fuzzy token with it (e.g. query mentions "Redis"; a memory about
    // "caching" that never says "Redis" is linked only via the graph edge
    // Redis->caching created by a *different* memory). Without this, entity
    // expansion could only re-rank memories BM25 already found — it could
    // never surface one BM25 missed entirely, which defeats the point of
    // having a knowledge-graph expansion at all.
    const entryById = new Map(entries.map((e) => [e.id, e]));
    for (const id of boostedIds) {
      if (bm25MatchedIds.has(id)) continue;
      const entry = entryById.get(id);
      if (!entry) continue;
      if (entry.ttl && !filter.includeExpired) {
        const created = new Date(entry.ts).getTime();
        if (now - created > entry.ttl * 1000) continue;
      }
      bm25Valid.push({ entry, score: 0.3, method: "entity" });
      boosted = true;
    }

    // Re-sort so entity-boosted entries actually rise in ranking
    if (boosted) {
      bm25Valid.sort((a, b) => b.score - a.score);
    }

    // If vectors are available, do hybrid RRF fusion
    let final: SearchResult[];
    if (this.vectorStore && this.useVectors) {
      try {
        const vectorResults = await this.vectorStore.search(filter.query, (filter.limit ?? 20) * 2);
        final = await this.mergeHybrid(bm25Valid, vectorResults, entries, filter.limit ?? 20);
      } catch {
        // Fall back to BM25 if vector search fails
        final = bm25Valid.slice(0, filter.limit ?? 20);
      }
    } else {
      final = bm25Valid.slice(0, filter.limit ?? 20);
    }

    // Down-weight low-confidence memories so unverified content surfaces last
    // without being dropped entirely. A memory at the default 0.7 confidence
    // keeps ~0.9 of its score; an unverified 0.2 keeps ~0.6.
    for (const r of final) {
      const conf = r.entry.confidence ?? 0.7;
      r.score *= 0.5 + 0.5 * conf;
    }
    final.sort((a, b) => b.score - a.score);

    // A returned search hit is a real access — feeds decay-aware importance
    // (see importance.ts). Fire-and-forget: this must never slow down recall.
    for (const r of final) {
      this.store.touch(r.entry.id, r.entry.type).catch(() => {});
    }

    return final.map((r) => ({ ...r, entry: this.annotateFreshness(r.entry) }));
  }

  /**
   * Merge BM25 and vector results using RRF (Reciprocal Rank Fusion).
   * Entries appearing in only one list still get a partial RRF score.
   */
  private async mergeHybrid(
    bm25: SearchResult[],
    vector: { id: string; score: number }[],
    entries: MemoryEntry[],
    limit: number,
  ): Promise<SearchResult[]> {
    const entryMap = new Map(entries.map((e) => [e.id, e]));
    const rrfScores = new Map<string, { entry: MemoryEntry; score: number; method: SearchResult["method"] }>();

    // RRF scores: BM25 ranks
    bm25.forEach((r, i) => {
      const rrf = 1 / (RRF_K + i + 1);
      rrfScores.set(r.entry.id, { entry: r.entry, score: rrf, method: r.method });
    });

    // RRF scores: vector ranks (add to existing or create new)
    vector.forEach((v, i) => {
      const rrf = 1 / (RRF_K + i + 1);
      const existing = rrfScores.get(v.id);
      if (existing) {
        existing.score += rrf;
      } else {
        // Vector-only result: fetch full entry from store
        const entry = entryMap.get(v.id);
        if (entry) {
          rrfScores.set(v.id, { entry, score: rrf, method: "vector" as const });
        }
      }
    });

    // Sort by RRF score descending
    return Array.from(rrfScores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => ({
        entry: r.entry,
        score: r.score,
        method: r.method,
      }));
  }

  /**
   * Delete a memory by id and type.
   */
  async forget(id: string, type: MemoryType): Promise<boolean> {
    const deleted = await this.store.deleteEntry(id, type);
    if (deleted) {
      if (this.vectorStore) {
        this.vectorStore.removeMemory(id).catch(() => {});
      }
      this.entityGraph.removeMemory(id).catch(() => {});
    }
    return deleted;
  }

  /**
   * Clear all working memory for a specific agent (or all agents).
   * Also cleans up vector store and entity graph to prevent data leaks.
   */
  async clearWorking(agent?: string): Promise<number> {
    // Collect IDs before clearing so we can clean up vector/entity indices
    const workEntries = await this.store.listEntries("working");
    const toClear = agent
      ? workEntries.filter((e) => e.agent === agent)
      : workEntries;
    const ids = toClear.map((e) => e.id);

    const count = await this.store.clearType("working", agent);

    // Clean up vector store and entity graph for the removed entries
    for (const id of ids) {
      if (this.vectorStore) {
        this.vectorStore.removeMemory(id).catch(() => {});
      }
      this.entityGraph.removeMemory(id).catch(() => {});
    }

    return count;
  }

  /**
   * Run auto-consolidation: merges similar memories by tag overlap.
   */
  async consolidate(): Promise<ConsolidationResult> {
    const entries = await this.store.listEntries();
    return consolidateMemories(
      entries,
      async (entry) => { await this.store.updateEntry(entry); return entry; },
      async (id, type, consolidatedBy) => {
        const entry = await this.store.getEntry(id, type);
        if (entry) {
          entry.archived = true;
          entry.consolidatedBy = consolidatedBy;
          await this.store.updateEntry(entry);
          return true;
        }
        return false;
      },
    );
  }

  /**
   * List unresolved contradictions: memories flagged as being in tension with
   * others (the "tie" case from write-time conflict resolution) plus any
   * quarantined memories awaiting verification. For human/agent review.
   */
  async listConflicts(): Promise<{
    flagged: { entry: MemoryEntry; contradicts: MemoryEntry[] }[];
    quarantined: MemoryEntry[];
  }> {
    const all = await this.store.listEntries();
    const byId = new Map(all.map((e) => [e.id, e]));
    const flagged: { entry: MemoryEntry; contradicts: MemoryEntry[] }[] = [];
    const quarantined: MemoryEntry[] = [];

    for (const e of all) {
      if (e.archived || e.pruned || e.validTo) continue;
      if (e.quarantined) {
        quarantined.push(this.annotateFreshness(e));
        continue;
      }
      if (e.contradicts && e.contradicts.length > 0) {
        const others = e.contradicts
          .map((id) => byId.get(id))
          .filter((x): x is MemoryEntry => !!x && !x.validTo && !x.archived);
        if (others.length > 0) {
          flagged.push({ entry: this.annotateFreshness(e), contradicts: others.map((o) => this.annotateFreshness(o)) });
        }
      }
    }
    return { flagged, quarantined };
  }

  /**
   * Resolve a contradiction explicitly. `keep` un-quarantines a memory and (if
   * it contradicted others) invalidates the losing side; `reject` invalidates
   * the target itself. This is the manual override for the write-time
   * arbitration — an agent or user deciding a tie the store couldn't.
   */
  async verifyMemory(
    id: string,
    type: MemoryType,
    decision: "keep" | "reject",
  ): Promise<MemoryEntry | null> {
    const entry = await this.store.getEntry(id, type);
    if (!entry) return null;
    const now = new Date().toISOString();

    if (decision === "reject") {
      entry.validTo = now;
      entry.quarantined = false;
      await this.store.updateEntry(entry);
      this.entityGraph.removeMemory(id).catch(() => {});
      if (this.vectorStore) this.vectorStore.removeMemory(id).catch(() => {});
      return this.annotateFreshness(entry);
    }

    // keep: promote this memory and invalidate whatever it contradicted.
    const wasQuarantined = entry.quarantined;
    entry.quarantined = false;
    for (const otherId of entry.contradicts ?? []) {
      for (const t of ["fact", "insight"] as MemoryType[]) {
        const other = await this.store.getEntry(otherId, t);
        if (!other || other.validTo) continue;
        other.validTo = now;
        other.supersededBy = entry.id;
        await this.store.updateEntry(other);
        this.entityGraph.removeMemory(otherId).catch(() => {});
        if (this.vectorStore) this.vectorStore.removeMemory(otherId).catch(() => {});
        entry.supersedes = [...(entry.supersedes ?? []), otherId];
      }
    }
    entry.contradicts = [];
    await this.store.updateEntry(entry);

    // A kept-and-verified memory re-enters the indices it was held out of.
    if (wasQuarantined) {
      if (this.vectorStore) this.vectorStore.addMemory(entry.id, entry.type, entry.agent, entry.content, entry.tags).catch(() => {});
      this.entityGraph.indexMemory(entry.id, entry.content, entry.tags).catch(() => {});
    }
    return this.annotateFreshness(entry);
  }

  /**
   * Reflective insight synthesis: cluster related memories and ask the LLM
   * reflector to distill NEW higher-level insights, saved back as durable
   * `insight` memories tagged `reflection`. No-op (returns []) without an API
   * key. Distinct from `consolidate()`, which merges near-duplicates verbatim.
   */
  async reflect(opts?: { agent?: string; maxClusters?: number }): Promise<MemoryEntry[]> {
    if (!this.reflector) return [];
    const agent = opts?.agent ?? "reflector";
    const maxClusters = opts?.maxClusters ?? 8;

    const all = (await this.store.listEntries()).filter(
      (e) => (e.type === "fact" || e.type === "insight" || e.type === "chunk") &&
        !e.archived && !e.pruned && !e.validTo && !e.quarantined &&
        !(e.meta as Record<string, unknown> | undefined)?.reflection,
    );

    const clusters = clusterByTags(all).slice(0, maxClusters);
    const created: MemoryEntry[] = [];

    for (const cluster of clusters) {
      let insights: Reflection[] = [];
      try {
        insights = await this.reflector(cluster);
      } catch {
        insights = [];
      }
      for (const ins of insights) {
        const entry = await this.remember(agent, "insight", ins.content, {
          tags: Array.from(new Set([...ins.tags, "reflection"])),
          confidence: ins.confidence,
          sourceTrust: 0.6,
          meta: { reflection: true, reflectedFrom: ins.sourceIds.length ? ins.sourceIds : cluster.map((m) => m.id) },
          // Reflections summarize existing memories; they shouldn't invalidate them.
          checkConflicts: false,
        });
        created.push(entry);
      }
    }
    return created;
  }

  /**
   * Promote working memories that have proven reusable (retrieved at least
   * `minAccessCount` times) into durable long-term memory. This is the
   * working → long-term tier transition: a scratchpad note an agent keeps
   * recalling is, by definition, no longer a scratchpad note.
   */
  async promoteWorkingMemories(opts?: { minAccessCount?: number; targetType?: "fact" | "insight" }): Promise<MemoryEntry[]> {
    const minAccessCount = opts?.minAccessCount ?? 3;
    const targetType = opts?.targetType ?? "insight";

    const working = await this.store.listEntries("working");
    const promoted: MemoryEntry[] = [];

    for (const entry of working) {
      if (entry.archived) continue;
      if ((entry.accessCount ?? 0) < minAccessCount) continue;

      const moved = await this.store.moveType(
        {
          ...entry,
          promotedFrom: { id: entry.id, type: entry.type },
          // Reset access counters on the promoted entry — its usage history
          // starts fresh under the new tier's decay curve.
          accessCount: 0,
          lastAccessedAt: undefined,
        },
        targetType,
      );
      promoted.push(moved);

      // Re-index under the new type/id-preserving move.
      if (this.vectorStore) {
        this.vectorStore.removeMemory(entry.id).catch(() => {});
        this.vectorStore.addMemory(moved.id, moved.type, moved.agent, moved.content, moved.tags).catch(() => {});
      }
    }

    return promoted;
  }

  /**
   * Soft-delete (archive) durable memories whose decayed importance has
   * fallen below `minImportance` after being untouched for `minStaleDays`.
   * Distinct from `consolidate()`, which merges near-duplicates regardless
   * of value — this targets genuinely low-value entries nobody recalls.
   * Soft-delete (not forget()) so pruned entries stay auditable/recoverable.
   */
  async pruneStaleMemories(opts?: { minImportance?: number; minStaleDays?: number }): Promise<MemoryEntry[]> {
    const minImportance = opts?.minImportance ?? 0.2;
    const minStaleDays = opts?.minStaleDays ?? 60;
    const now = new Date();

    const candidates = await this.store.listEntries();
    const pruned: MemoryEntry[] = [];

    for (const entry of candidates) {
      if (entry.archived || entry.pruned || entry.type === "working") continue;

      const factors = extractFactors(entry, now);
      if (factors.daysSinceAccess < minStaleDays) continue;

      const decayed = computeImportance({ ...factors, explicitScore: undefined });
      if (decayed >= minImportance) continue;

      entry.pruned = true;
      entry.importance = decayed;
      await this.store.updateEntry(entry);
      pruned.push(entry);
    }

    return pruned;
  }

  /**
   * Start a background maintenance cycle: promotes reusable working memory
   * and prunes stale low-value memory on the given interval. Runs alongside
   * (not instead of) TTL cleanup.
   */
  startMaintenanceCycle(intervalMs: number = 900_000): void {
    if (this.maintenanceTimer) return;
    this.maintenanceTimer = setInterval(async () => {
      try {
        await this.promoteWorkingMemories();
        await this.pruneStaleMemories();
      } catch {
        // best-effort — never let maintenance crash the server
      }
    }, intervalMs);
    this.maintenanceTimer.unref();
  }

  stopMaintenanceCycle(): void {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
  }

  /**
   * Get memory statistics, including a new/recent/aging/stale breakdown so
   * an agent (or a human reviewing the store) can see memory freshness at a
   * glance without inspecting individual entries.
   */
  async getStats() {
    const stats = await this.store.getStats();
    const all = await this.store.listEntries();
    const now = new Date();

    const byFreshness = { new: 0, recent: 0, aging: 0, stale: 0 };
    for (const e of all) {
      const ageDays = Math.max(0, (now.getTime() - new Date(e.ts).getTime()) / 86_400_000);
      byFreshness[classifyFreshness(ageDays)]++;
    }

    return { ...stats, byFreshness };
  }

  /**
   * Explain how two entities relate: the shortest relation path through the
   * knowledge graph, plus the memories that witness the connecting edges.
   */
  async explainRelation(from: string, to: string): Promise<{ path: import("./entity.js").PathHop[]; memories: MemoryEntry[] }> {
    const path = await this.entityGraph.findPath(from, to);
    if (path.length === 0) return { path, memories: [] };

    // Gather the memories that witness any hop, newest first.
    const ids = new Set<string>();
    for (const hop of path) {
      for (const id of await this.entityGraph.getMemoryIdsForEntity(hop.from)) ids.add(id);
      for (const id of await this.entityGraph.getMemoryIdsForEntity(hop.to)) ids.add(id);
    }
    const all = await this.store.listEntries();
    const byId = new Map(all.map((e) => [e.id, e]));
    const memories = Array.from(ids)
      .map((id) => byId.get(id))
      .filter((e): e is MemoryEntry => !!e && !e.archived && !e.pruned)
      .map((e) => this.annotateFreshness(e));
    return { path, memories };
  }

  /** Knowledge-graph statistics (entity/edge counts). */
  async graphStats(): Promise<{ entityCount: number; edgeCount: number }> {
    return this.entityGraph.getStats();
  }

  /**
   * Release resources. Stops background timers and closes the SQLite graph
   * handle (no-op for the file-backed JSON graph). Call on shutdown so the
   * WAL file is flushed and unlocked.
   */
  close(): void {
    this.stopTTLCleanup();
    this.stopMaintenanceCycle();
    const g = this.entityGraph as { close?: () => void };
    if (typeof g.close === "function") g.close();
  }

  /**
   * Plug in an optional triple extractor (e.g. an LLM) for richer, typed graph
   * edges. Without one, the graph relies on heuristic capitalization + a tech
   * keyword list, which cannot capture lowercase domain concepts like
   * "caching". Purely additive — passing null reverts to heuristics only.
   */
  setGraphExtractor(extractor: import("./entity.js").TripleExtractor | null): void {
    this.entityGraph.setExtractor(extractor);
  }

  /**
   * List all entries of a given type (for resource listing).
   */
  async listByType(type: MemoryType): Promise<MemoryEntry[]> {
    const entries = await this.store.listEntries(type);
    return entries.map((e) => this.annotateFreshness(e));
  }
}
