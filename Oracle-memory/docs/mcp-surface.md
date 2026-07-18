---
title: MCP Surface
---

# MCP Surface

## Tools

### `remember`

Save a memory (fact, insight, chunk, or working).

**Inputs:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent` | string | yes | Agent name (1-64 chars) |
| `type` | enum | yes | `fact`, `insight`, `chunk`, `working` |
| `content` | string | yes | Memory content |
| `tags` | string[] | no | Categorization tags |
| `source` | string | no | Source context (session, project) |
| `importance` | number | no | Override auto-scored importance (0-1) |
| `ttl` | integer | no | Time-to-live in seconds |

**Output:**

```json
{
  "success": true,
  "memory": {
    "id": "20260713-120000-000000-a1b2",
    "ts": "2026-07-13T12:00:00.000Z",
    "agent": "claude",
    "type": "insight",
    "content": "...",
    "tags": ["config"],
    "importance": 0.72
  }
}
```

### `recall`

Search across all memories with hybrid ranking.

**Inputs:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query |
| `agent` | string | no | Filter by agent |
| `type` | enum | no | Filter by memory type |
| `tags` | string[] | no | Filter by tags |
| `limit` | integer | no | Max results (default 20, max 200) |

**Output:**

```json
{
  "success": true,
  "results": [
    {
      "entry": { "id": "...", "content": "...", ... },
      "score": 0.0325,
      "method": "bm25"
    }
  ],
  "count": 1
}
```

### `get_memory`

Retrieve a single memory by ID and type.

**Inputs:** `id` (string), `type` (enum)

**Output:** Full memory entry or `{success: false, error: "Memory not found"}`.

### `update_memory`

Update mutable fields of an existing memory. Re-indexes vector store and entity graph.

**Inputs:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Memory ID |
| `type` | enum | yes | Memory type |
| `content` | string | no | New content |
| `tags` | string[] | no | New tags |
| `importance` | number | no | Override importance (0-1) |
| `meta` | object | no | Metadata updates (merged shallow) |
| `ttl` | integer | no | New TTL in seconds |

**Output:** Updated memory entry.

### `list_memories`

List memories with optional type/agent/tags/query filters.

**Inputs:** `type?` (enum), `agent?` (string), `tags?` (string[]), `limit?` (int, default 50, max 200), `query?` (string)

**Output:** `{success, memories: [...], count}`.

### `forget`

Permanently delete a memory by ID and type.

**Inputs:** `id` (string), `type` (enum)

**Output:** `{success: true, deleted: true}`.

### `clear_working`

Clear working memory for an agent (or all agents if omitted). Also cleans up vector and entity graph indices.

**Inputs:** `agent?` (string)

**Output:** `{success: true, cleared: <count>}`.

### `consolidate`

Run auto-consolidation: merges similar memories by tag overlap.
Archives originals, creates consolidated entries.

**Output:**

```json
{
  "success": true,
  "result": {
    "consolidated": 3,
    "archived": ["id2", "id3"],
    "created": { "id": "id1", "content": "...", "tags": ["jwt", "auth"], ... }
  }
}
```

### `get_sessions`

List currently connected agent sessions (HTTP transport only).

**Output:**

```json
{
  "success": true,
  "sessions": [
    { "id": "uuid", "agent": "claude", "transport": "http", "connectedAt": "...", "lastActivity": "..." }
  ]
}
```

### `get_stats`

Get memory statistics (count by type and agent).

**Output:** `{success: true, stats: {totalMemories, byType, byAgent, oldestMemory, newestMemory}}`.

## Resources

| URI | Returns |
|-----|---------|
| `oracle-memory://memories` | All stored memories (newest first, max 200) |
| `oracle-memory://memories/{type}` | Memories filtered by type |
| `oracle-memory://stats` | Memory statistics |
| `oracle-memory://sessions` | Currently connected agent sessions |

All resources return `application/json`.

## HTTP endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/mcp` | POST | MCP JSON-RPC messages |
| `/mcp` | GET | SSE stream (streamable HTTP) |
| `/health` | GET | Health check: `{"status":"ok","uptime":123,"sessions":2}` |

## Instructions

The server advertises the following instructions on initialization:

> **Oracle Memory Server**
>
> File-backed persistent memory for AI coding agents.
>
> Memory Types: fact (permanent knowledge), insight (lessons learned),
> chunk (conversation snapshots), working (session scratchpad)
>
> Workflow:
> 1. Use `remember` to save important information
> 2. Use `recall` to search across all memories
> 3. Use `update_memory` to edit existing memories
> 4. Use `list_memories` to browse by type or agent
> 5. Working memory clears automatically between sessions
