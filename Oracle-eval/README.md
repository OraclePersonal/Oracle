# Oracle-eval

> The benchmark suite that tells you if the stack is actually working.

MCP server for evaluating and benchmarking the Oracle multi-agent coordination stack.
Measures memory retrieval quality (recall@k, MRR, temporal accuracy) and message
bus throughput (send/poll latency). Generates SVG bar-chart reports.

## Quick start

```bash
npm install && npm run build
npm run dev              # MCP server (stdio)
npm run bench            # run benchmarks
```

## Tools

| Tool | Description |
|------|-------------|
| `eval_memory` | Benchmark oracle-memory retrieval quality (recall@k, MRR, temporal) |
| `eval_messages` | Benchmark oracle-messages throughput (send/poll latency) |

## Benchmarks

```bash
npm run bench                              # full suite
npm run bench -- --quick                   # memory quality only
npm run bench -- --memory http://host:8765 # custom endpoint
npm run bench -- --output ./report.svg     # custom output
```

Results rendered as `bench/results/results.svg`.

## Layout

```
src/
├── index.ts            # MCP server entry point
├── types.ts            # Shared types
├── eval/
│   ├── memory.ts       # Memory evaluator
│   └── messages.ts     # Messages evaluator
└── report.ts           # SVG report generator
bench/
└── run.ts              # Standalone runner
```

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | Compile TypeScript |
| `npm run check` | Type-check only |
| `npm run dev` | Run MCP server via tsx |
| `npm start` | Run compiled |
| `npm test` | Run tests |
| `npm run bench` | Run benchmarks |

## Related

- [Oracle](https://github.com/JonusNattapong/Oracle) — CLI for AI code consulting
- [Oracle-memory](https://github.com/JonusNattapong/Oracle-memory) — File-backed MCP memory server
- [Oracle-messages](https://github.com/JonusNattapong/Oracle-messages) — MCP message bus
- [Oracle-templates](https://github.com/JonusNattapong/Oracle-templates) — Template system
