import { describe, it, expect } from "vitest";
import {
  pruneStaleMemories,
  promoteWorkingMemories,
  runMaintenance,
  type MaintenanceOptions,
} from "./maintenance.js";
import type { MemoryStoreEntry } from "./adapter.js";

// ── Helpers ───────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<MemoryStoreEntry> & { id: string }): MemoryStoreEntry {
  return {
    ts: new Date().toISOString(),
    agent: "test",
    type: "fact",
    content: "test content",
    tags: [],
    meta: {},
    accessCount: 0,
    lastAccessed: new Date().toISOString(),
    decayRate: 0.01,
    ...overrides,
  };
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

// ── pruneStaleMemories ────────────────────────────────────────────────────

describe("pruneStaleMemories", () => {
  it("prunes old, low-importance facts", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({
        id: "1",
        type: "fact",
        content: "old unused fact",
        importance: 0.05,
        lastAccessed: daysAgo(60),
        ts: daysAgo(60),
      }),
    ];

    const saveCalls: MemoryStoreEntry[] = [];
    const pruned = await pruneStaleMemories(entries, { minStaleDays: 30, minImportance: 0.2 }, async (e) => {
      saveCalls.push(e);
    });

    expect(pruned).toContain("1");
    expect(saveCalls).toHaveLength(1);
    expect((saveCalls[0] as any).pruned).toBe(true);
  });

  it("does not prune entries with importance above threshold", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({
        id: "1",
        type: "fact",
        importance: 0.8,
        lastAccessed: daysAgo(60),
        ts: daysAgo(60),
      }),
    ];

    const pruned = await pruneStaleMemories(entries);
    expect(pruned).not.toContain("1");
  });

  it("does not prune recently accessed entries", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({
        id: "1",
        type: "fact",
        importance: 0.05,
        lastAccessed: new Date().toISOString(),
        ts: daysAgo(60),
      }),
    ];

    const pruned = await pruneStaleMemories(entries, { minStaleDays: 30, minImportance: 0.2 });
    expect(pruned).not.toContain("1");
  });

  it("does not prune working or chunk type entries", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({ id: "1", type: "working", importance: 0.05, lastAccessed: daysAgo(60) }),
      makeEntry({ id: "2", type: "chunk", importance: 0.05, lastAccessed: daysAgo(60) }),
    ];

    const pruned = await pruneStaleMemories(entries);
    expect(pruned).toEqual([]);
  });

  it("does not prune archived entries", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({
        id: "1",
        type: "fact",
        importance: 0.05,
        lastAccessed: daysAgo(60),
        archived: true,
      }),
    ];

    const pruned = await pruneStaleMemories(entries);
    expect(pruned).toEqual([]);
  });

  it("does not prune entries that were already consolidated", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({
        id: "1",
        type: "fact",
        importance: 0.05,
        lastAccessed: daysAgo(60),
        consolidatedBy: "consolidated-entry-id",
      }),
    ];

    const pruned = await pruneStaleMemories(entries);
    expect(pruned).toEqual([]);
  });

  it("skips entries already flagged as pruned", async () => {
    const entries: MemoryStoreEntry[] = [
      Object.assign(
        makeEntry({ id: "1", type: "fact", importance: 0.05, lastAccessed: daysAgo(60) }),
        { pruned: true },
      ),
    ];

    const pruned = await pruneStaleMemories(entries);
    expect(pruned).toEqual([]);
  });

  it("uses default options when opts is omitted", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({
        id: "1",
        type: "fact",
        importance: 0.05,
        lastAccessed: daysAgo(60),
        ts: daysAgo(60),
      }),
    ];

    const pruned = await pruneStaleMemories(entries);
    // Default minStaleDays=30, minImportance=0.2 → should prune
    expect(pruned).toContain("1");
  });

  it("does not call saveFn when omitted", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({
        id: "1",
        type: "fact",
        importance: 0.05,
        lastAccessed: daysAgo(60),
        ts: daysAgo(60),
      }),
    ];

    const pruned = await pruneStaleMemories(entries);
    expect(pruned).toContain("1");
    // No saveFn → entries mutated in memory but not persisted
    expect((entries[0] as any).pruned).toBe(true);
  });

  it("returns empty array when no entries match", async () => {
    const pruned = await pruneStaleMemories([]);
    expect(pruned).toEqual([]);
  });
});

// ── promoteWorkingMemories ────────────────────────────────────────────────

describe("promoteWorkingMemories", () => {
  it("promotes working memories with sufficient access count using saveFn+deleteFn", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({ id: "1", type: "working", content: "frequently accessed note", accessCount: 5 }),
    ];

    const savedEntries: MemoryStoreEntry[] = [];
    const deleted: Array<{ id: string; type: string }> = [];

    const promoted = await promoteWorkingMemories(
      entries,
      { minAccessCount: 3 },
      async (e) => { savedEntries.push(e); },
      async (id, type) => { deleted.push({ id, type }); },
    );

    expect(promoted).toContain("1");
    expect(savedEntries).toHaveLength(1);
    expect(savedEntries[0].type).toBe("insight");
    expect(savedEntries[0].accessCount).toBe(0);
    expect(savedEntries[0].meta.promotedFrom).toEqual({ id: "1", type: "working" });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toEqual({ id: "1", type: "working" });
  });

  it("promotes working memories using moveFn", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({ id: "1", type: "working", content: "frequently accessed", accessCount: 5 }),
    ];

    const moved: Array<{ id: string; toType: string }> = [];

    const promoted = await promoteWorkingMemories(
      entries,
      { minAccessCount: 3 },
      undefined,
      undefined,
      async (entry, targetType) => {
        moved.push({ id: entry.id, toType: targetType });
        return entry;
      },
    );

    expect(promoted).toContain("1");
    expect(moved).toHaveLength(1);
    expect(moved[0].toType).toBe("insight");
  });

  it("does not promote entries below access count threshold", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({ id: "1", type: "working", accessCount: 1 }),
    ];

    const promoted = await promoteWorkingMemories(entries, { minAccessCount: 3 });
    expect(promoted).toEqual([]);
  });

  it("does not promote non-working type entries", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({ id: "1", type: "fact", accessCount: 10 }),
      makeEntry({ id: "2", type: "insight", accessCount: 10 }),
      makeEntry({ id: "3", type: "chunk", accessCount: 10 }),
    ];

    const promoted = await promoteWorkingMemories(entries);
    expect(promoted).toEqual([]);
  });

  it("does not promote archived working entries", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({ id: "1", type: "working", accessCount: 10, archived: true }),
    ];

    const promoted = await promoteWorkingMemories(entries);
    expect(promoted).toEqual([]);
  });

  it("returns empty list when no persistence callbacks are provided", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({ id: "1", type: "working", accessCount: 5 }),
    ];

    const promoted = await promoteWorkingMemories(entries, { minAccessCount: 3 });
    // Without callbacks, the candidate is identified but not returned
    expect(promoted).toEqual([]);
  });

  it("uses default minAccessCount of 3 with callbacks", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({ id: "1", type: "working", accessCount: 3 }),
    ];

    const promoted = await promoteWorkingMemories(
      entries,
      undefined,
      async () => {},
      async () => {},
    );
    expect(promoted).toContain("1");
  });

  it("returns empty array when no entries", async () => {
    const promoted = await promoteWorkingMemories([]);
    expect(promoted).toEqual([]);
  });
});

// ── runMaintenance ────────────────────────────────────────────────────────

describe("runMaintenance", () => {
  it("runs both prune and promote and returns combined result", async () => {
    const entries: MemoryStoreEntry[] = [
      // Will be pruned: old, low-importance fact
      makeEntry({
        id: "1",
        type: "fact",
        importance: 0.05,
        lastAccessed: daysAgo(60),
        ts: daysAgo(60),
      }),
      // Will be promoted: high-access working memory
      makeEntry({ id: "2", type: "working", accessCount: 5 }),
      // Will be left alone: recent fact
      makeEntry({ id: "3", type: "fact", importance: 0.8 }),
    ];

    const prunedIds: string[] = [];
    const savedEntries: MemoryStoreEntry[] = [];
    const deleted: Array<{ id: string; type: string }> = [];

    const result = await runMaintenance(
      entries,
      { minStaleDays: 30, minImportance: 0.2, minAccessCount: 3 },
      async (e) => {
        // Used by both prune (updates in-place) and promote (creates new)
        savedEntries.push(e);
      },
      async (id, type) => { deleted.push({ id, type }); },
    );

    expect(result.pruned).toContain("1");
    expect(result.promoted).toContain("2");
  });

  it("handles empty entries gracefully", async () => {
    const result = await runMaintenance([]);
    expect(result.pruned).toEqual([]);
    expect(result.promoted).toEqual([]);
  });

  it("does not fail when callbacks are omitted (dry-run)", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({ id: "1", type: "fact", importance: 0.05, lastAccessed: daysAgo(60), ts: daysAgo(60) }),
      makeEntry({ id: "2", type: "working", accessCount: 5 }),
    ];

    const result = await runMaintenance(entries);
    expect(result.pruned).toContain("1");
    // promoteWorkingMemories returns empty without callbacks
    expect(result.promoted).toEqual([]);
  });
});
