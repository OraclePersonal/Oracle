import { describe, it, expect } from "vitest";
import { consolidateMemories, type ConsolidationResult } from "./consolidation.js";
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

function saveFnStub(): Promise<MemoryStoreEntry> {
  return Promise.resolve({} as MemoryStoreEntry);
}

function archiveFnStub(): Promise<boolean> {
  return Promise.resolve(true);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("consolidateMemories", () => {
  it("returns zero consolidated when given no entries", async () => {
    const result = await consolidateMemories([], saveFnStub, archiveFnStub);
    expect(result.consolidated).toBe(0);
    expect(result.created).toBeNull();
    expect(result.archived).toEqual([]);
  });

  it("returns zero consolidated when entries have no tag overlap", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({ id: "1", content: "About TypeScript", tags: ["typescript"] }),
      makeEntry({ id: "2", content: "About Redis", tags: ["redis"] }),
    ];
    const result = await consolidateMemories(entries, saveFnStub, archiveFnStub);
    expect(result.consolidated).toBe(0);
  });

  it("merges entries with overlapping tags", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({ id: "1", content: "First note about auth", tags: ["auth", "security"] }),
      makeEntry({ id: "2", content: "Second note about auth", tags: ["auth", "security"] }),
    ];

    let saved: MemoryStoreEntry | undefined;
    const archivedIds: string[] = [];

    const result = await consolidateMemories(
      entries,
      async (e) => {
        saved = e;
        return e;
      },
      async (id) => {
        archivedIds.push(id);
        return true;
      },
    );

    expect(result.consolidated).toBe(1); // one entry was merged
    expect(result.archived).toHaveLength(1);
    expect(archivedIds).toContain("2");
    expect(saved).toBeDefined();
    expect(saved!.tags).toContain("auth");
    expect(saved!.meta.consolidated).toBe(true);
    expect(saved!.meta.consolidatedFrom).toContain("2");
  });

  it("skips archived entries", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({ id: "1", content: "Active note", tags: ["auth"], archived: false }),
      makeEntry({ id: "2", content: "Archived note", tags: ["auth"], archived: true }),
    ];
    const result = await consolidateMemories(entries, saveFnStub, archiveFnStub);
    expect(result.consolidated).toBe(0);
  });

  it("skips working type entries", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({ id: "1", content: "Working scratch", tags: ["scratch"], type: "working" }),
      makeEntry({ id: "2", content: "Another working", tags: ["scratch"], type: "working" }),
    ];
    const result = await consolidateMemories(entries, saveFnStub, archiveFnStub);
    expect(result.consolidated).toBe(0);
  });

  it("skips entries older than MAX_AGE_DAYS (90)", async () => {
    const oldDate = new Date(Date.now() - 91 * 86_400_000).toISOString();
    const entries: MemoryStoreEntry[] = [
      makeEntry({ id: "1", content: "Old note", tags: ["auth"], ts: oldDate }),
      makeEntry({ id: "2", content: "Also old", tags: ["auth"], ts: oldDate }),
    ];
    const result = await consolidateMemories(entries, saveFnStub, archiveFnStub);
    expect(result.consolidated).toBe(0);
  });

  it("deduplicates identical content across merged entries", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({ id: "1", content: "Same content", tags: ["test"] }),
      makeEntry({ id: "2", content: "Same content", tags: ["test"] }),
    ];

    let saved: MemoryStoreEntry | undefined;
    await consolidateMemories(
      entries,
      async (e) => {
        saved = e;
        return e;
      },
      archiveFnStub,
    );

    // Content should appear only once
    expect(saved!.content).toBe("Same content");
  });

  it("truncates content exceeding MAX_CONTENT_LENGTH", async () => {
    const longContent = "A".repeat(1500);
    const entries: MemoryStoreEntry[] = [
      makeEntry({ id: "1", content: longContent, tags: ["test"] }),
      makeEntry({ id: "2", content: "B".repeat(1000), tags: ["test"] }),
    ];

    let saved: MemoryStoreEntry | undefined;
    await consolidateMemories(
      entries,
      async (e) => {
        saved = e;
        return e;
      },
      archiveFnStub,
    );

    expect(saved!.content.length).toBeLessThanOrEqual(2000 + "\n[...]".length);
    expect(saved!.content).toContain("[...]");
  });

  it("merges tags from all entries in the group", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({ id: "1", content: "Note one", tags: ["auth", "security"] }),
      makeEntry({ id: "2", content: "Note two", tags: ["auth", "performance"] }),
    ];

    let saved: MemoryStoreEntry | undefined;
    await consolidateMemories(
      entries,
      async (e) => {
        saved = e;
        return e;
      },
      archiveFnStub,
    );

    expect(saved!.tags).toContain("auth");
    expect(saved!.tags).toContain("security");
    expect(saved!.tags).toContain("performance");
  });

  it("creates consolidation metadata on the saved entry", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({ id: "1", content: "Lead entry", tags: ["test"] }),
      makeEntry({ id: "2", content: "Follower entry", tags: ["test"] }),
    ];

    let saved: MemoryStoreEntry | undefined;
    const result = await consolidateMemories(
      entries,
      async (e) => {
        saved = e;
        return e;
      },
      archiveFnStub,
    );

    expect(saved!.meta.consolidated).toBe(true);
    // consolidatedFrom includes all group members (including the "best" one)
    expect(saved!.meta.consolidatedFrom).toEqual(["1", "2"]);
    expect(saved!.meta.consolidatedCount).toBe(2);
    expect(typeof saved!.meta.consolidatedAt).toBe("string");
    expect(result.created?.meta.consolidated).toBe(true);
  });

  it("handles multiple groups simultaneously", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({ id: "1", content: "Auth note", tags: ["auth"] }),
      makeEntry({ id: "2", content: "More auth", tags: ["auth"] }),
      makeEntry({ id: "3", content: "Cache note", tags: ["cache"] }),
      makeEntry({ id: "4", content: "More cache", tags: ["cache"] }),
      makeEntry({ id: "5", content: "Standalone", tags: ["other"] }),
    ];

    let saveCount = 0;
    const archived: string[] = [];

    const result = await consolidateMemories(
      entries,
      async (e) => {
        saveCount++;
        return e;
      },
      async (id) => {
        archived.push(id);
        return true;
      },
    );

    // Two groups should have been consolidated (auth group + cache group)
    expect(result.consolidated).toBe(2);
    expect(archived).toHaveLength(2);
    expect(saveCount).toBe(2);
  });

  it("propagates errors from saveFn and archiveFn", async () => {
    const entries: MemoryStoreEntry[] = [
      makeEntry({ id: "1", content: "Note 1", tags: ["test"] }),
      makeEntry({ id: "2", content: "Note 2", tags: ["test"] }),
    ];

    await expect(
      consolidateMemories(
        entries,
        async () => { throw new Error("save failed"); },
        async () => { throw new Error("archive failed"); },
      ),
    ).rejects.toThrow();
  });
});
