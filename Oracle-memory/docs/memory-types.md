---
title: Memory Types
---

# Memory Types

Oracle Memory organizes memories into four categories, each with different retention
policies and use cases.

| Type | Prefix | Retention | Best for |
|------|--------|-----------|----------|
| `fact` | `.oracle-memory/facts/` | Permanent | Project conventions, preferences, decisions |
| `insight` | `.oracle-memory/insights/` | Permanent | Lessons learned, gotchas, bug workarounds |
| `chunk` | `.oracle-memory/chunks/` | TTL-based | Session context snapshots |
| `working` | `.oracle-memory/working/` | Cleared between sessions | Scratchpad, temp state |

## Retention details

- **fact / insight** — Retained until explicitly deleted with `forget`.
- **chunk** — Auto-deleted after TTL expires (configurable via `ttl` parameter).
  A background job runs every 5 minutes to clean up expired chunks.
- **working** — Cleared on session end with `clear_working`.

## Usage rules

- All types support tags, importance scoring, and full-text search.
- All types are indexed in the vector store (if enabled) and entity graph.
- `update_memory` can change any memory's fields regardless of type.
- Working memory is indexed for search during the session; cleanup also removes
  vector and entity graph entries to prevent data leaks.
