# Oracle Memory

File-backed Memory MCP server for multi-agent coordination.

## What it does

Oracle Memory is an MCP server that lets AI coding agents persist and retrieve
knowledge across sessions. There is no database — memories are stored as JSON
files under a `.oracle-memory/` directory (default: `.oracle-memory/` in the
server's working directory, overridable). Four memory types are supported:
`fact` (permanent knowledge), `insight` (lessons learned), `chunk`
(session/context snapshots, optionally TTL-scoped), and `working` (a
session scratchpad, auto-cleared by maintenance). Retrieval uses hybrid
ranking: BM25 keyword search, optional semantic vector search, and an entity
relationship graph. Durable writes run contradiction detection; background
maintenance promotes reused working memories and prunes stale low-value ones.

## Install / Build

```bash
npm install
npm run build        # tsc → dist/
```

Dev mode (no build):

```bash
npm run dev          # tsx src/index.ts
```

Type-check / test:

```bash
npm run check        # tsc --noEmit
npm test             # vitest run
```

## Run

The compiled entry point is `dist/index.js` (also available as the
`oracle-memory` bin).

```bash
node dist/index.js                                   # stdio (default)
npm start                                            # same as above
ORACLE_MEMORY_TRANSPORT=http node dist/index.js      # HTTP / streamable transport
```

Register with an MCP client (stdio):

```json
{ "mcpServers": { "oracle-memory": { "command": "node", "args": ["/path/to/oracle-memory/dist/index.js"] } } }
```

HTTP (multi-agent hub):

```bash
ORACLE_MEMORY_TRANSPORT=http ORACLE_MEMORY_PORT=8765 node dist/index.js
```

## MCP Tools

The server exposes three MCP tools:

- `remember` — Save a memory (`agent`, `type`, `content`, plus optional
  `tags`, `source`, `importance`, `ttl`, `confidence`, `sourceTrust`,
  `checkConflicts`). If `entry_id` is supplied it updates an existing memory
  instead of creating a new one.
- `recall` — Search memories. Pass `query` (empty lists all), or `id` to fetch
  a single memory, or `graph_query` to explore related entities. Supports
  `agent`, `type`, `tags`, `limit` (default 20, max 200), and
  `includeExpired` filters.
- `forget` — Permanently delete a memory by `id` + `type`, or clear all
  `working` memories for an `agent`.

(`getMemory`, `updateMemory`, `listMemories`, `consolidate`, `getStats`,
`clearWorking`, and conflict handling exist internally but are not surfaced
as separate MCP tools — they are reachable through `remember`/`recall`/`forget`
or via the resources below.)

## MCP Resources

- `oracle-memory://memories` — all memories (newest first, max 200)
- `oracle-memory://memories/{type}` — memories filtered by type
- `oracle-memory://stats` — counts by type and agent
- `oracle-memory://sessions` — currently connected agent sessions
- `oracle-memory://conflicts` — flagged contradictions and quarantined memories

## HTTP endpoints (HTTP transport only)

| Path | Method | Description |
|------|--------|-------------|
| `/mcp` | POST | MCP JSON-RPC messages |
| `/health` | GET | Health check: `{"status":"ok","uptime":123,"sessions":2}` |

## Configuration

All configuration is via environment variables. Variable names with the
`AGOYA_` prefix are accepted as aliases for the corresponding `ORACLE_MEMORY_`
variable.

| Variable | Default | Description |
|----------|---------|-------------|
| `ORACLE_MEMORY_ROOT_DIR` | `cwd` | Data root; memories stored in `<root>/.oracle-memory/` |
| `ORACLE_MEMORY_DISABLE_VECTORS` | `false` | Set `1`/`true` to disable semantic vector search |
| `ORACLE_MEMORY_TRANSPORT` | `stdio` | `stdio` or `http`/`streamable` |
| `ORACLE_MEMORY_HOST` | `0.0.0.0` | HTTP bind host |
| `ORACLE_MEMORY_PORT` | `8765` | HTTP port |
| `ORACLE_MEMORY_HTTP_TOKEN` | — | Bearer token required for HTTP requests when set |
| `ORACLE_MEMORY_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `ORACLE_MEMORY_LLM_GRAPH` | `false` | Set `1` to enable the LLM triple extractor (requires `ANTHROPIC_API_KEY`) |

## On-disk layout

```
.oracle-memory/
├── config.json
├── facts/        # type="fact"   (permanent)
├── insights/     # type="insight" (lessons)
├── chunks/       # type="chunk"   (snapshots, TTL)
├── working/      # type="working" (scratchpad)
├── graph/        # entity relationship graph (json) or sqlite
└── vectors/      # embedding index (optional, when vectors enabled)
```

## Related

- [Oracle](https://github.com/JonusNattapong/Oracle) — CLI for AI code consulting
- [Oracle-messages](https://github.com/JonusNattapong/Oracle-messages) — MCP message bus
- [Oracle-dashboard](https://github.com/JonusNattapong/Oracle-dashboard) — live web dashboard
- [Oracle-eval](https://github.com/JonusNattapong/Oracle-eval) — benchmark suite
