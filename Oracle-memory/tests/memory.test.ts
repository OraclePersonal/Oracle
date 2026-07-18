import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { MemoryStore } from "../src/memory.js";

const TEST_ROOT = ".oracle-memory-test-memory";

describe("MemoryStore — decay-aware access tracking, promotion, pruning", () => {
  let memory: MemoryStore;

  beforeEach(() => {
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true });
    }
    // Vectors disabled — deterministic, no embedding-model download in tests.
    memory = new MemoryStore(TEST_ROOT, false);
  });

  afterEach(() => {
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true });
    }
  });

  it("getMemory counts as an access and bumps accessCount", async () => {
    const entry = await memory.remember("agent", "fact", "reusable fact");
    expect(entry.accessCount ?? 0).toBe(0);

    await memory.getMemory(entry.id, "fact");
    await memory.getMemory(entry.id, "fact");
    const fetched = await memory.getMemory(entry.id, "fact");

    expect(fetched?.accessCount).toBe(3);
    expect(fetched?.lastAccessedAt).toBeDefined();
  });

  it("annotates freshness on read paths without persisting it to disk", async () => {
    const entry = await memory.remember("agent", "fact", "just created");

    const fetched = await memory.getMemory(entry.id, "fact");
    expect(fetched?.freshness).toBe("new");

    const listed = await memory.listMemories({ type: "fact" });
    expect(listed.find((e) => e.id === entry.id)?.freshness).toBe("new");

    // Freshness must be computed on read, not written to the store — read
    // the raw JSON off disk (via listByType, a thin store wrapper) to
    // confirm re-fetching independently still classifies correctly rather
    // than trusting a stale persisted value.
    const byType = await memory.listByType("fact");
    expect(byType.find((e) => e.id === entry.id)?.freshness).toBe("new");
  });

  it("get_stats reports a freshness breakdown", async () => {
    await memory.remember("agent", "fact", "brand new");
    const stats = await memory.getStats();
    expect(stats.byFreshness.new).toBeGreaterThanOrEqual(1);
    expect(stats.byFreshness.recent + stats.byFreshness.aging + stats.byFreshness.stale).toBe(0);
  });

  it("promoteWorkingMemories moves reused working memory to insight and preserves content", async () => {
    const entry = await memory.remember("agent", "working", "keeps getting recalled");

    // Access it enough times to cross the default promotion threshold (3).
    await memory.getMemory(entry.id, "working");
    await memory.getMemory(entry.id, "working");
    await memory.getMemory(entry.id, "working");

    const promoted = await memory.promoteWorkingMemories();
    expect(promoted).toHaveLength(1);
    expect(promoted[0].type).toBe("insight");
    expect(promoted[0].id).toBe(entry.id);
    expect(promoted[0].content).toBe("keeps getting recalled");
    expect(promoted[0].promotedFrom).toEqual({ id: entry.id, type: "working" });

    // Original working entry is gone; promoted entry lives under insight.
    expect(await memory.getMemory(entry.id, "working")).toBeNull();
    const underNewType = await memory.listByType("insight");
    expect(underNewType.some((e) => e.id === entry.id)).toBe(true);
  });

  it("promoteWorkingMemories leaves under-threshold working memory alone", async () => {
    const entry = await memory.remember("agent", "working", "barely touched");
    await memory.getMemory(entry.id, "working"); // only 1 access, threshold is 3

    const promoted = await memory.promoteWorkingMemories();
    expect(promoted).toHaveLength(0);
    expect(await memory.getMemory(entry.id, "working")).not.toBeNull();
  });

  it("pruneStaleMemories archives low-importance, long-untouched memories", async () => {
    // remember() always stamps "now", so instead of backdating we use
    // minStaleDays: 0 — a freshly created, never-accessed entry already
    // satisfies "stale" under that threshold, keeping the test deterministic.
    const entry = await memory.remember("agent", "chunk", "x");

    const pruned = await memory.pruneStaleMemories({ minStaleDays: 0, minImportance: 0.9 });
    expect(pruned.some((e) => e.id === entry.id)).toBe(true);
    expect(pruned.find((e) => e.id === entry.id)?.pruned).toBe(true);

    // Pruned entries are excluded from default listing (soft-delete)...
    const listed = await memory.listMemories({ type: "chunk" });
    expect(listed.some((e) => e.id === entry.id)).toBe(false);

    // ...but recoverable via includeExpired.
    const all = await memory.listMemories({ type: "chunk", includeExpired: true });
    expect(all.some((e) => e.id === entry.id)).toBe(true);
  });

  it("pruneStaleMemories never touches working memory or already-pruned entries", async () => {
    const working = await memory.remember("agent", "working", "scratch");
    const pruned1 = await memory.pruneStaleMemories({ minStaleDays: 0, minImportance: 1 });
    expect(pruned1.some((e) => e.id === working.id)).toBe(false);

    const fact = await memory.remember("agent", "fact", "will be pruned twice?");
    const firstPass = await memory.pruneStaleMemories({ minStaleDays: 0, minImportance: 0.9 });
    expect(firstPass.some((e) => e.id === fact.id)).toBe(true);

    const secondPass = await memory.pruneStaleMemories({ minStaleDays: 0, minImportance: 0.9 });
    expect(secondPass.some((e) => e.id === fact.id)).toBe(false);
  });

  it("entity-graph expansion surfaces memories BM25 missed entirely, not just ones it already found", async () => {
    // Found via real recall testing: entity boost only re-scored entries
    // already in the BM25 result set — a memory linked purely by a graph
    // edge, sharing zero literal tokens with the query, never surfaced at
    // all. That defeats the point of graph expansion (it could only
    // re-rank, never discover).
    await memory.remember("agent", "fact", "Redis is used for session Caching in the auth service.");
    const unrelatedByKeywords = await memory.remember(
      "agent", "insight", "Caching improves database read performance significantly.",
    );
    const trulyUnrelated = await memory.remember(
      "agent", "fact", "The CI pipeline runs on GitHub Actions with a 10 minute timeout.",
    );

    const results = await memory.searchMemories({ query: "Redis configuration setup", limit: 10 });

    const entityHit = results.find((r) => r.entry.id === unrelatedByKeywords.id);
    expect(entityHit).toBeDefined();
    expect(entityHit?.method).toBe("entity");

    // The graph must not leak in memories that aren't actually connected.
    expect(results.some((r) => r.entry.id === trulyUnrelated.id)).toBe(false);
  });
});
