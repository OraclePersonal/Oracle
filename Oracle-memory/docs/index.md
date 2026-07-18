---
title: Oracle Memory — Agent Memory
---

# Oracle Memory — Agent Memory

**File-backed Memory MCP Server for multi-agent coordination.**

Persistent memory layer that AI coding agents (Claude Code, Codex, OpenCode, agy, Clew)
connect to via MCP. No database, no external service — just JSON files under `.oracle-memory/`.

## Quick Start

### stdio (single agent)
```bash
node /path/to/oracle-memory/dist/index.js
```

### HTTP hub (multi-agent)
```bash
ORACLE_MEMORY_TRANSPORT=http ORACLE_MEMORY_PORT=8765 node /path/to/oracle-memory/dist/index.js
```

## Documentation

| Doc | Description |
|-----|-------------|
| [Architecture](architecture.md) | System architecture and layers |
| [Memory Types](memory-types.md) | Fact, insight, chunk, working |
| [Search](search.md) | BM25 + vector + graph hybrid search |
| [On-Disk Layout](on-disk-layout.md) | File system structure |
| [MCP Surface](mcp-surface.md) | All tools, resources, and schemas |

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `ORACLE_MEMORY_ROOT_DIR` | `cwd` | Data directory for `.oracle-memory/` |
| `ORACLE_MEMORY_TRANSPORT` | `stdio` | Transport mode (`stdio`, `http`) |
| `ORACLE_MEMORY_HOST` | `0.0.0.0` | HTTP bind host |
| `ORACLE_MEMORY_PORT` | `8765` | HTTP port |
| `ORACLE_MEMORY_HTTP_TOKEN` | — | Bearer auth for HTTP mode |
| `ORACLE_MEMORY_DISABLE_VECTORS` | `false` | Set `1` to disable vector search |

Old `AGOYA_*` env vars work as fallbacks.

## License

MIT
