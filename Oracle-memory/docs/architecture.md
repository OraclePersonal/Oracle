---
title: Architecture
---

# Architecture

Oracle Memory is a **file-backed MCP server** providing persistent memory for AI coding agents.

## High-level layout

```
┌──────────────────────────────────────────────────────────────┐
│  Claude Code / Codex / OpenCode / agy / Clew                 │
│  (MCP client)                                                │
└──────────┬───────────────────────────────────────────────────┘
           │ MCP (stdio / HTTP)
           ▼
┌──────────────────────────────────────────────────────────────┐
│  oracle-memory (MCP server)                                   │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │  MemoryStore │──│    Store     │──│  .oracle-memory/*     │ │
│  │  (orchestr.) │  │  (file I/O)  │  │  (JSON files)        │ │
│  ├─────────────┤  ├──────────────┤  ├──────────────────────┤ │
│  │  VectorStore │  │  EntityGraph │  │  .oracle-memory/graph │ │
│  │  (vectra)    │  │  (entity rel)│  │  .oracle-memory/vectors│ │
│  └─────────────┘  └──────────────┘  └──────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

## Components

| Component | File | Responsibility |
|-----------|------|----------------|
| **Store** | `src/store.ts` | Atomic file I/O, CRUD on JSON entries |
| **MemoryStore** | `src/memory.ts` | Orchestrator: remember, recall, consolidate, update |
| **Search** | `src/search.ts` | BM25 keyword search with stop-word filtering |
| **VectorStore** | `src/vectorStore.ts` | Semantic embedding + vector search (vectra) |
| **EntityGraph** | `src/entity.ts` | Entity extraction + relationship graph |
| **Importance** | `src/importance.ts` | Heuristic importance scoring (0-1) |
| **Consolidator** | `src/consolidator.ts` | Tag-similarity merging |
| **Logger** | `src/logger.ts` | Structured JSON logging |
| **Server** | `src/server.ts` | MCP tool/resource registration, HTTP transport |
| **CLI** | `src/index.ts` | CLI entrypoint, graceful shutdown |

## Data flow

### remember
```
agent → MemoryStore.remember()
         ├── Store.createEntry()     → .oracle-memory/{type}/{id}.json
         ├── VectorStore.addMemory() → .oracle-memory/vectors/ (fire-and-forget)
         └── EntityGraph.indexMemory() → .oracle-memory/graph/graph.json
```

### recall
```
agent → MemoryStore.searchMemories()
         ├── Store.listEntries()     → load all JSON files
         ├── searchEntries()         → BM25 keyword ranking
         ├── EntityGraph.expandQuery() → entity relationship boost
         └── VectorStore.search()    → fusion via RRF (if vectors enabled)
```

### update_memory
```
agent → MemoryStore.updateMemory()
         ├── Store.updateEntry()     → overwrite .oracle-memory/{type}/{id}.json
         ├── VectorStore.removeMemory() + addMemory() → re-index
         └── EntityGraph.removeMemory() + indexMemory() → re-index
```

## Transport

| Transport | File | Description |
|-----------|------|-------------|
| **stdio** | `StdioServerTransport` | Default, single agent |
| **HTTP** | `StreamableHTTPServerTransport` | Multi-agent hub, port 8765 |
| Health | built-in | `GET /health` returns `{"status":"ok","uptime":N}` |

## Key design decisions

- **File-backed** — No database, no external processes. Zero configuration.
- **Atomic writes** — Write `.tmp` → rename. No corruption from crashes.
- **Best-effort indexing** — Vector/entity indexing failures don't block `remember`.
- **Graceful degradation** — Vector store unavailable → falls back to BM25-only.
- **Backward compat env vars** — Old `AGOYA_*` env vars still work.
