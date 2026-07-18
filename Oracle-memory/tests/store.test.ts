import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { Store } from "../src/store.js";
import type { MemoryEntry } from "../src/types.js";

const TEST_ROOT = ".oracle-memory-test";

describe("Store", () => {
  let store: Store;

  beforeEach(() => {
    // Clean any leftover test data
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true });
    }
    store = new Store(TEST_ROOT);
  });

  afterEach(() => {
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true });
    }
  });

  it("creates directory structure on init", async () => {
    // Store creates an entry which triggers dir creation
    await store.createEntry({
      id: "dirtest", ts: new Date().toISOString(), agent: "t", type: "fact",
      content: "dir test", tags: [], meta: {},
    });
    // Now check that dirs exist
    expect(existsSync(`${TEST_ROOT}/.oracle-memory/facts`)).toBe(true);
    expect(existsSync(`${TEST_ROOT}/.oracle-memory`)).toBe(true);
  });

  it("creates and reads an entry", async () => {
    const entry: MemoryEntry = {
      id: "test-001",
      ts: new Date().toISOString(),
      agent: "test-agent",
      type: "fact",
      content: "test content",
      tags: ["test"],
      meta: { key: "value" },
    };

    await store.createEntry(entry);
    const read = await store.getEntry("test-001", "fact");
    expect(read).not.toBeNull();
    expect(read!.content).toBe("test content");
    expect(read!.tags).toEqual(["test"]);
    expect(read!.meta).toEqual({ key: "value" });
  });

  it("lists entries by type", async () => {
    await store.createEntry({
      id: "f1", ts: "2024-01-01T00:00:00.000Z", agent: "a", type: "fact", content: "fact1", tags: [], meta: {},
    });
    await store.createEntry({
      id: "i1", ts: "2024-01-01T00:00:00.000Z", agent: "a", type: "insight", content: "insight1", tags: [], meta: {},
    });

    const facts = await store.listEntries("fact");
    expect(facts.length).toBe(1);
    expect(facts[0].type).toBe("fact");

    const all = await store.listEntries();
    expect(all.length).toBe(2);
  });

  it("deletes an entry", async () => {
    await store.createEntry({
      id: "del1", ts: new Date().toISOString(), agent: "a", type: "working", content: "delete me", tags: [], meta: {},
    });

    const deleted = await store.deleteEntry("del1", "working");
    expect(deleted).toBe(true);

    const read = await store.getEntry("del1", "working");
    expect(read).toBeNull();
  });

  it("returns stats", async () => {
    await store.createEntry({
      id: "s1", ts: "2024-01-01T00:00:00.000Z", agent: "alice", type: "fact", content: "x", tags: [], meta: {},
    });
    await store.createEntry({
      id: "s2", ts: "2024-06-01T00:00:00.000Z", agent: "bob", type: "insight", content: "y", tags: [], meta: {},
    });

    const stats = await store.getStats();
    expect(stats.totalMemories).toBe(2);
    expect(stats.byType.fact).toBe(1);
    expect(stats.byType.insight).toBe(1);
    expect(stats.byAgent.alice).toBe(1);
    expect(stats.byAgent.bob).toBe(1);
  });

  it("clears working memory by agent", async () => {
    await store.createEntry({
      id: "w1", ts: new Date().toISOString(), agent: "alice", type: "working", content: "w1", tags: [], meta: {},
    });
    await store.createEntry({
      id: "w2", ts: new Date().toISOString(), agent: "bob", type: "working", content: "w2", tags: [], meta: {},
    });

    const deleted = await store.clearType("working", "alice");
    expect(deleted).toBe(1);

    const remaining = await store.listEntries("working");
    expect(remaining.length).toBe(1);
    expect(remaining[0].agent).toBe("bob");
  });

  it("touch bumps accessCount and lastAccessedAt", async () => {
    await store.createEntry({
      id: "t1", ts: "2024-01-01T00:00:00.000Z", agent: "a", type: "fact", content: "x", tags: [], meta: {},
    });

    const first = await store.touch("t1", "fact");
    expect(first?.accessCount).toBe(1);
    expect(first?.lastAccessedAt).toBeDefined();

    const second = await store.touch("t1", "fact");
    expect(second?.accessCount).toBe(2);

    const missing = await store.touch("nope", "fact");
    expect(missing).toBeNull();
  });

  it("moveType relocates an entry to a new type directory, preserving id", async () => {
    await store.createEntry({
      id: "m1", ts: "2024-01-01T00:00:00.000Z", agent: "a", type: "working", content: "promote me", tags: [], meta: {},
    });

    const moved = await store.moveType(
      (await store.getEntry("m1", "working"))!,
      "insight",
    );
    expect(moved.type).toBe("insight");
    expect(moved.id).toBe("m1");

    expect(await store.getEntry("m1", "working")).toBeNull();
    const relocated = await store.getEntry("m1", "insight");
    expect(relocated).not.toBeNull();
    expect(relocated!.content).toBe("promote me");
  });

  it("concurrent touch() calls on the same entry never throw, even though updates can be lost", async () => {
    // Found via real MCP-client usage: recall()'s fire-and-forget touch and
    // a get_memory() touch on the same entry, overlapping in-process, used
    // to both write "${filePath}.tmp" and race each other's rename — one
    // call would fail with ENOENT ("...tmp" already consumed by the other).
    // A unique-per-call tmp name plus an EPERM/EBUSY retry on the final
    // rename (Windows can transiently lock the destination mid-replace)
    // fixes the crash. This is a read-modify-write counter, not a proper
    // atomic increment — under heavy concurrency some increments can still
    // be lost (documented trade-off in Store.touch), so this test asserts
    // "never throws" and "count moved forward", not "exactly N".
    await store.createEntry({
      id: "race1", ts: new Date().toISOString(), agent: "a", type: "fact", content: "x", tags: [], meta: {},
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.touch("race1", "fact")),
    );

    expect(results.every((r) => r !== null)).toBe(true);
    const final = await store.getEntry("race1", "fact");
    expect(final?.accessCount ?? 0).toBeGreaterThanOrEqual(1);
    expect(final?.accessCount ?? 0).toBeLessThanOrEqual(10);
  });
});
