# oracle-eval

MCP server and standalone runner for benchmarking the Oracle multi-agent stack (oracle-memory and oracle-messages).

## What it does

A TypeScript MCP server that runs quality and throughput benchmarks against live Oracle stack components over HTTP, and renders the results as an SVG bar-chart report. The memory evaluator measures `recall@k`, MRR, and temporal correctness (whether newer info displaces older info). The messages evaluator measures send/poll latency and throughput against an `oracle-messages` server. It can run as an MCP server (`oracle-eval`) or as a standalone benchmark harness via the `bench` script.

## Build / Install

```bash
npm install
npm run build      # compile TypeScript to dist/ (tsc)
npm run check      # type-check only
npm run dev        # run MCP server directly via tsx (no build)
npm start          # run built server (node dist/index.js)
npm test           # run vitest suite
```

## Usage

### As an MCP server

```bash
npm run dev        # stdio MCP server
# or, after building:
oracle-eval        # bin -> dist/index.js
```

The server exposes two tools (called via MCP `tools/call`):

- `eval_memory` — benchmark oracle-memory retrieval quality.
  - `memoryEndpoint` (string, default `http://localhost:8765`)
  - `limit` (number, default `5`) — k for recall@k
  - `quick` (boolean, default `false`) — skip scale phase
- `eval_messages` — benchmark oracle-messages throughput.
  - `messagesEndpoint` (string, default `http://localhost:8766`)
  - `iterations` (number, default `50`)
  - `payloadSize` (number, default `256` bytes)

### As a benchmark runner (SVG report)

```bash
npm run bench                                       # full suite (memory + messages)
npm run bench -- --quick                            # memory quality only
npm run bench -- --memory http://localhost:8765     # custom memory endpoint
npm run bench -- --messages http://localhost:8766   # custom messages endpoint
npm run bench -- --output ./custom-report.svg       # custom output path
```

Outputs an SVG report to `bench/results/results.svg` (or the path given with `--output`).

## Configuration / environment variables

- `ORACLE_EVAL_MEMORY_ENDPOINT` — default memory endpoint (falls back to `http://localhost:8765`).
- `ORACLE_EVAL_MESSAGES_ENDPOINT` — default messages endpoint (falls back to `http://localhost:8766`).

If no endpoint is set, the corresponding benchmark phase is skipped unless supplied explicitly.
