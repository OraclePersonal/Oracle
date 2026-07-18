# Oracle Memory (AGENTS.md)

Guide for any coding agent joining this multi-agent workspace.

## What is Oracle Memory?

A **file-backed memory MCP server** where agents store and retrieve persistent
knowledge across sessions. No database — just JSON files under `.oracle-memory/`.

## How to connect

### Option A: stdio (default, single agent)

Add to `.mcp.json`:

```json
{ "mcpServers": { "oracle-memory": { "command": "node", "args": ["/path/to/oracle-memory/dist/index.js"] } } }
```

### Option B: HTTP (multi-agent hub)

Start the hub:
```bash
ORACLE_MEMORY_TRANSPORT=http ORACLE_MEMORY_PORT=8765 node dist/index.js
```

Register each agent:
```bash
claude mcp add --transport http oracle-memory http://localhost:8765/mcp
```

## Memory types

| Type | When to use | Lifetime |
|------|-------------|---------|
| `fact` | Project conventions, config values, decisions | Forever |
| `insight` | Bugs discovered, gotchas, optimization tips | Forever |
| `chunk` | Conversation/context snapshots | TTL-based |
| `working` | Scratchpad for current task | Session only |

## Agent workflow

```
1. On session start:
   → recall(query="project context", limit=5)
   ← get recent context about the project

2. When you learn something:
   → remember(agent="your_name", type="insight",
       content="Don't use || in default values",
       tags=["gotcha", "typescript"])

3. Before /compact or end of session:
   → remember(agent="your_name", type="chunk",
       content="We were discussing...",
       tags=["session"], ttl=604800)

4. When searching:
   → recall(query="port configuration", agent="claude")
   ← BM25 + vector + entity graph hybrid results
```

## Important conventions

- Always pass your agent name in `agent` field
- Tag generously — tags power entity graph + consolidation
- Use `type="fact"` for permanent knowledge
- Use `type="insight"` for lessons learned
- Clear working memory between sessions: `clear_working(agent="your_name")`
- Run `consolidate()` periodically to merge duplicates

## Automatic features

- **Importance scoring**: every memory gets scored 0-1 on save
- **Entity extraction**: capitalized terms + tech keywords auto-indexed
- **Graph traversal**: searching "alice" also finds related "JWT", "TypeScript"
- **Hybrid search**: BM25 keyword + vector semantic + entity graph
- **Consolidation**: similar tag sets auto-merge on `consolidate()`

## MCP surface

See [docs/mcp-surface.md](docs/mcp-surface.md) for full tool/resource reference.
