---
title: Oracle Assistant
---

# Oracle Assistant

**A personal AI assistant you keep around** — persistent memory, knowledge base, web access, and multi-agent coordination.

## Quick Start

```bash
npm install && npm run build
node dist/cli.js doctor
node dist/cli.js consult -p "Review this" -f "src/**/*.ts"
```

## Documentation

| Doc | Description |
|-----|-------------|
| [Architecture](architecture.md) | System architecture and layers |
| [Getting Started](getting-started.md) | Install, configure, and run |

## Key Features

- **oracle ask** — Questions and code review with multi-turn continuity
- **oracle consult** — Analyze code with built-in skills (review, debug, architecture, tests, security)
- **oracle watch** — Autonomous working-tree review on quiet periods
- **45 MCP tools** — Memory, docs, web, GitHub, agent messaging, identity, locks
- **Knowledge base** — BM25-indexed .oracle/docs/ retrieval
- **Web providers** — Brave, Tavily, Firecrawl, AgentQL with auto-fallback
- **Multi-agent locks** — Fencing-token leases for safe concurrent access
- **Soul prompts** — Configurable personality (default/engineer/custom)
- **Memory wiki** — Topic-grouped memory compilation

## Scripts

| Script | Purpose |
|--------|---------|
| npm run build | Compile TypeScript |
| npm run check | Type-check only |
| npm run dev | Run CLI via tsx |
| npm run mcp | Run MCP server via tsx |
| npm start | Run compiled |
| npm test | Run tests |

## License

MIT