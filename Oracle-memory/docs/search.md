---
title: Search
---

# Search

Oracle Memory uses a **hybrid search** approach combining three strategies:

| Strategy | Method | When |
|----------|--------|------|
| **BM25** | Keyword tokenization + stop-word filtering | Always |
| **Vector** | Semantic embedding (`all-MiniLM-L6-v2`, 384-dim) | Optional (default on) |
| **Entity** | Entity graph relationship boost | Always |

## BM25 (always on)

Built-in, zero-dependency keyword search. The algorithm:

1. Tokenizes content + tags into lowercase tokens
2. Filters English stop words
3. Scores each document against the query using BM25
4. Boosts entries with matching tags (+0.5)
5. Falls back to fuzzy substring matching if BM25 yields nothing

```
query: "memory server"

  ┌─ "oracle-memory is a memory MCP server"  →  score: 2.08
  ├─ "the server needs more memory"           →  score: 0.45
  └─ "deploy the database server"             →  score: 0.12
```

## Vector (optional, default on)

When enabled (`ORACLE_MEMORY_DISABLE_VECTORS not set`), `remember` also indexes each memory
with a vector embedding using `Xenova/all-MiniLM-L6-v2` (384-dim).

On `recall`, results from BM25 and vector search are fused using
**RRF (Reciprocal Rank Fusion)** for the best of both worlds.

The model (~15MB) auto-downloads on first use and caches locally.

To disable:
```bash
ORACLE_MEMORY_DISABLE_VECTORS=1 oracle-memory
```

## Entity graph boost (always on)

Entity names (like "TypeScript", "JWT") are extracted from content and linked in a
relationship graph. When a query matches an entity, memories containing related
entities receive a score boost (+0.3) and are re-ranked.

## Ranking

Results are sorted by score descending. When vector search is active, BM25 and
vector rankings are merged using RRF (Reciprocal Rank Fusion) with K=60.
