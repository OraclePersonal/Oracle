import { describe, it, expect } from "vitest";
import { bm25Search, tokenize } from "./bm25.js";

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumeric, and drops stop words/short tokens", () => {
    expect(tokenize("The Redis Connection-Pool is exhausted!")).toEqual([
      "redis", "connection", "pool", "exhausted",
    ]);
  });
});

describe("bm25Search", () => {
  const docs = [
    { id: "a", text: "Redis connection pool exhausted after timeout" },
    { id: "b", text: "Postgres migration failed due to lock contention" },
    { id: "c", text: "Redis cache invalidation strategy for hot keys" },
  ];

  it("ranks documents containing more query terms higher", () => {
    const hits = bm25Search(docs, "redis connection pool", 10);
    expect(hits[0].id).toBe("a");
  });

  it("returns empty when no terms overlap and no substring matches", () => {
    expect(bm25Search(docs, "kubernetes", 10)).toEqual([]);
  });

  it("falls back to substring match when BM25 finds nothing", () => {
    const hits = bm25Search(docs, "postgres", 10);
    expect(hits.some((h) => h.id === "b")).toBe(true);
  });

  it("respects the limit", () => {
    const hits = bm25Search(docs, "redis", 1);
    expect(hits).toHaveLength(1);
  });

  it("returns [] for an empty query or empty corpus", () => {
    expect(bm25Search(docs, "", 10)).toEqual([]);
    expect(bm25Search([], "redis", 10)).toEqual([]);
  });
});
