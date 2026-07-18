import { describe, it, expect } from "vitest";
import { searchEntries } from "../src/search.js";
import type { MemoryEntry } from "../src/types.js";

const makeEntry = (id: string, content: string, tags: string[] = []): MemoryEntry => ({
  id,
  ts: new Date().toISOString(),
  agent: "test",
  type: "fact",
  content,
  tags,
  meta: {},
});

describe("BM25 search", () => {
  const entries = [
    makeEntry("1", "oracle-memory is a file-backed memory MCP server for multi-agent coordination", ["oracle-memory", "architecture"]),
    makeEntry("2", "BM25 search works better than simple grep for finding relevant memories", ["search", "bm25"]),
    makeEntry("3", "TypeScript strict mode prevents many common bugs", ["typescript", "config"]),
    makeEntry("4", "the database connection string should use environment variables", ["database", "config"]),
  ];

  it("finds relevant results by keyword", () => {
    const results = searchEntries(entries, { query: "memory server", limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.id).toBe("1"); // "memory" + "server" present
    expect(results[0].method).toBe("bm25");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("returns empty for non-matching query", () => {
    const results = searchEntries(entries, { query: "xyznonexistent", limit: 10 });
    expect(results.length).toBe(0);
  });

  it("filters by tags with tag-matched results", () => {
    // Entries 3 and 4 have the "config" tag
    const results = searchEntries(entries, { tags: ["config"], limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.entry.tags.includes("config"))).toBe(true);
  });

  it("filters by type", () => {
    const results = searchEntries(entries, { query: "memory", type: "insight", limit: 10 });
    expect(results.length).toBe(0); // All entries are type "fact"
  });

  it("filters by agent", () => {
    const results = searchEntries(entries, { query: "memory", agent: "nonexistent", limit: 10 });
    expect(results.length).toBe(0);
  });

  it("falls back to fuzzy match when BM25 finds nothing", () => {
    // "common bugs" matches entry 3 via substring, but not as complete BM25 tokens
    const results = searchEntries(entries, { query: "commn bug", limit: 10 });
    // "commn" and "bug" are substrings of "common bugs" in entry 3
    expect(results.some(r => r.entry.id === "3" && r.method === "fuzzy")).toBe(true);
  });

  it("fuzzy fallback does not false-match on stop words or single-character substrings", () => {
    // Found via real semantic-search testing: an earlier version matched raw,
    // untokenized query words against content via .includes() — so "i" (a
    // substring of nearly any word: "oracle", "typescript", "environment
    // variables") and "and" (a literal substring of most English sentences)
    // produced false-positive fuzzy hits against genuinely unrelated content,
    // which then out-ranked real semantic matches once fused with vector
    // search. None of these query words share a real token with any entry.
    const results = searchEntries(entries, { query: "how should i handle this and that", limit: 10 });
    expect(results).toHaveLength(0);
  });

  it("respects limit", () => {
    const results = searchEntries(entries, { query: "", limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("sorts by relevance score descending", () => {
    const results = searchEntries(entries, { query: "config", limit: 10 });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });
});

describe("No-query search", () => {
  it("returns all entries sorted by recency when no query", () => {
    const entries = [
      makeEntry("a", "oldest"),
      makeEntry("b", "middle"),
      makeEntry("c", "newest"),
    ];
    // Make timestamps differ
    entries[0].ts = "2024-01-01T00:00:00.000Z";
    entries[1].ts = "2024-06-01T00:00:00.000Z";
    entries[2].ts = "2024-12-01T00:00:00.000Z";

    const results = searchEntries(entries, { limit: 10 });
    expect(results.map((r) => r.entry.id)).toEqual(["c", "b", "a"]);
  });
});
