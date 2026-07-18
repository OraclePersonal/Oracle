import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { MemoryStore } from "../src/memory.js";
import { detectConflictsHeuristic } from "../src/conflict.js";
import { clusterByTags } from "../src/reflect.js";
import type { MemoryEntry } from "../src/types.js";

const TEST_ROOT = ".oracle-memory-test-conflict";

function entry(partial: Partial<MemoryEntry> & { content: string }): MemoryEntry {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    ts: new Date().toISOString(),
    agent: "a",
    type: "fact",
    tags: [],
    meta: {},
    ...partial,
  };
}

describe("detectConflictsHeuristic", () => {
  it("flags a negation flip on the same subject", () => {
    const existing = [entry({ content: "We cache query results in Redis for hot paths." })];
    const conflicts = detectConflictsHeuristic(
      { content: "We do not cache query results in Redis anymore.", tags: [] },
      existing,
    );
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].reason).toContain("negation");
  });

  it("flags an antonym flip (tabs → spaces)", () => {
    const existing = [entry({ content: "The team uses tabs for indentation." })];
    const conflicts = detectConflictsHeuristic(
      { content: "The team uses spaces for indentation.", tags: [] },
      existing,
    );
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].reason).toMatch(/antonym|reassignment/);
  });

  it("flags a single-value reassignment", () => {
    const existing = [entry({ content: "The primary database is PostgreSQL." })];
    const conflicts = detectConflictsHeuristic(
      { content: "The primary database is MySQL.", tags: [] },
      existing,
    );
    expect(conflicts.length).toBe(1);
  });

  it("flags a value reassignment past a filler noun, even when both sides negate", () => {
    // Regression: "runs on port 9000, not 8765" vs "runs on port 1234, not 9000"
    // — both contain "not" (no negation asymmetry) and both share the filler
    // "port"; the real change is the number, which the object extractor must reach.
    const existing = [entry({ content: "The dev server now runs on port 9000, not 8765." })];
    const conflicts = detectConflictsHeuristic(
      { content: "The dev server actually runs on port 1234, not 9000.", tags: [] },
      existing,
    );
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].reason).toContain("reassignment");
  });

  it("does not flag unrelated memories", () => {
    const existing = [entry({ content: "Logs ship to Datadog at INFO level." })];
    const conflicts = detectConflictsHeuristic(
      { content: "The team uses spaces for indentation.", tags: [] },
      existing,
    );
    expect(conflicts.length).toBe(0);
  });

  it("ignores already-invalidated memories", () => {
    const existing = [entry({ content: "The team uses tabs for indentation.", validTo: new Date().toISOString() })];
    const conflicts = detectConflictsHeuristic(
      { content: "The team uses spaces for indentation.", tags: [] },
      existing,
    );
    expect(conflicts.length).toBe(0);
  });
});

describe("MemoryStore — conflict resolution on remember", () => {
  let memory: MemoryStore;

  beforeEach(() => {
    if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
    memory = new MemoryStore(TEST_ROOT, false);
  });

  afterEach(() => {
    if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  });

  it("a higher-trust new fact supersedes and invalidates the old one", async () => {
    const old = await memory.remember("a", "fact", "The team uses tabs for indentation.", { confidence: 0.6, sourceTrust: 0.4 });
    const neu = await memory.remember("a", "fact", "The team uses spaces for indentation.", { confidence: 0.95, sourceTrust: 0.9 });

    expect(neu.supersedes).toContain(old.id);
    expect((neu.meta as any).conflictsResolved[0].action).toBe("supersede");

    // Old is temporally invalidated and excluded from recall.
    const refetchedOld = await memory.listMemories({ includeExpired: true });
    expect(refetchedOld.find((e) => e.id === old.id)?.validTo).toBeDefined();

    const results = await memory.searchMemories({ query: "indentation for the team" });
    expect(results.some((r) => r.entry.id === old.id)).toBe(false);
    expect(results.some((r) => r.entry.id === neu.id)).toBe(true);
  });

  it("a lower-trust new fact is quarantined out of recall", async () => {
    await memory.remember("a", "fact", "The primary database is PostgreSQL.", { confidence: 0.9, sourceTrust: 0.9 });
    const weak = await memory.remember("a", "fact", "The primary database is MySQL.", { confidence: 0.2, sourceTrust: 0.2 });

    expect(weak.quarantined).toBe(true);
    const results = await memory.searchMemories({ query: "primary database" });
    expect(results.some((r) => r.entry.id === weak.id)).toBe(false);

    const conflicts = await memory.listConflicts();
    expect(conflicts.quarantined.some((e) => e.id === weak.id)).toBe(true);
  });

  it("a tie flags both memories for review", async () => {
    const a = await memory.remember("a", "fact", "The team uses tabs for indentation.", { confidence: 0.7, sourceTrust: 0.5 });
    const b = await memory.remember("a", "fact", "The team uses spaces for indentation.", { confidence: 0.7, sourceTrust: 0.5 });

    expect(b.contradicts).toContain(a.id);
    const conflicts = await memory.listConflicts();
    expect(conflicts.flagged.length).toBeGreaterThanOrEqual(1);
  });

  it("verify_memory keep un-quarantines and invalidates the loser", async () => {
    const strong = await memory.remember("a", "fact", "The primary database is PostgreSQL.", { confidence: 0.9, sourceTrust: 0.9 });
    const weak = await memory.remember("a", "fact", "The primary database is MySQL.", { confidence: 0.2, sourceTrust: 0.2 });
    expect(weak.quarantined).toBe(true);

    const kept = await memory.verifyMemory(weak.id, "fact", "keep");
    expect(kept?.quarantined).toBe(false);
    expect(kept?.supersedes).toContain(strong.id);

    const results = await memory.searchMemories({ query: "primary database" });
    expect(results.some((r) => r.entry.id === weak.id)).toBe(true);
    expect(results.some((r) => r.entry.id === strong.id)).toBe(false);
  });

  it("working memory writes skip conflict checks by default", async () => {
    await memory.remember("a", "working", "The team uses tabs.", {});
    const w = await memory.remember("a", "working", "The team uses spaces.", {});
    expect(w.quarantined).toBeUndefined();
    expect((w.meta as any).conflictsResolved).toBeUndefined();
  });

  it("low-confidence memories rank below high-confidence ones on recall", async () => {
    await memory.remember("a", "fact", "Deploys use a canary rollout strategy today.", { confidence: 0.95 });
    await memory.remember("a", "insight", "A separate note about canary rollout monitoring dashboards.", { confidence: 0.2 });
    const results = await memory.searchMemories({ query: "canary rollout" });
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect((results[0].entry.confidence ?? 0.7)).toBeGreaterThan(results[results.length - 1].entry.confidence ?? 0.7);
  });
});

describe("reflect — clusterByTags", () => {
  it("groups tag-overlapping memories and drops singletons", () => {
    const memories = [
      entry({ id: "1", content: "a", tags: ["db", "perf"] }),
      entry({ id: "2", content: "b", tags: ["perf", "cache"] }),
      entry({ id: "3", content: "c", tags: ["auth"] }),
    ];
    const clusters = clusterByTags(memories);
    expect(clusters.length).toBe(1);
    expect(clusters[0].map((m) => m.id).sort()).toEqual(["1", "2"]);
  });

  it("reflect is a no-op without an LLM reflector configured", async () => {
    if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
    const memory = new MemoryStore(TEST_ROOT, false);
    await memory.remember("a", "fact", "one", { tags: ["x"] });
    await memory.remember("a", "fact", "two", { tags: ["x"] });
    const created = await memory.reflect();
    expect(created).toEqual([]);
    rmSync(TEST_ROOT, { recursive: true });
  });
});
