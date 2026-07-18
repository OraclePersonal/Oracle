# Oracle Memory

> The notebook your AI agents never lose. No database, no server farm — just JSON files and a really good search.

Every coding session, your agent learns something: a port number, a gotcha, a decision.
And every session, it forgets. **Oracle Memory** is the fix — a file-backed MCP memory
server that lets agents *remember* across sessions and *find* what they wrote with
hybrid keyword + semantic search.

```
remember ──▶ .oracle-memory/* ──▶ recall
               (atomic writes)    (BM25 + vectors + entity graph)
```

No Postgres. No Redis. No migrations.

## Quick start

```bash
npm install && npm run build
npm start              # stdio MCP server
```

Wire it into Claude Code:

```bash
claude mcp add oracle-memory -- node /path/to/oracle-memory/dist/index.js
```

## Tools (3)

| Tool | What it does |
|------|--------------|
| `remember` | Save a memory. `entry_id` to update existing. |
| `recall` | Search with `query`, fetch one with `id`, explore graph with `graph_query` |
| `forget` | Delete one by `id`+`type`, or clear `working` by `agent` |

Auto-maintained every 15 min: consolidation (merge duplicates), promotion
(working→insight), pruning (stale→archive). No manual tools needed.

## Layout

```
.oracle-memory/
├── facts/          # Permanent knowledge
├── insights/       # Lessons learned
├── chunks/         # Session snapshots (TTL)
├── working/        # Scratchpads (auto-cleared)
├── graph/          # Entity relationship graph
└── vectors/        # Embeddings (optional)
```

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | Compile TypeScript |
| `npm run check` | Type-check only |
| `npm run dev` | Run via tsx |
| `npm start` | Run compiled |
| `npm test` | Run tests |
| `npm run bench` | Run benchmarks |

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `ORACLE_MEMORY_ROOT_DIR` | `cwd` | Store root |
| `ORACLE_MEMORY_DISABLE_VECTORS` | `false` | `1` to disable vector search |
| `ORACLE_MEMORY_TRANSPORT` | `stdio` | `stdio` or `http` |
| `ORACLE_MEMORY_HOST` | `0.0.0.0` | HTTP bind host |
| `ORACLE_MEMORY_PORT` | `8765` | HTTP port |
| `ORACLE_MEMORY_HTTP_TOKEN` | — | Bearer token |

## Related

- [Oracle](https://github.com/JonusNattapong/Oracle) — CLI for AI code consulting
- [Oracle-messages](https://github.com/JonusNattapong/Oracle-messages) — MCP message bus
- [Oracle-skill](https://github.com/JonusNattapong/Oracle-skill) — Cross-agent workflow docs
- [Oracle-templates](https://github.com/JonusNattapong/Oracle-templates) — Template system
- [Oracle-dashboard](https://github.com/JonusNattapong/Oracle-dashboard) — Live web dashboard
- [Oracle-eval](https://github.com/JonusNattapong/Oracle-eval) — Benchmark suite
