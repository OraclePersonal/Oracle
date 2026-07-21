# Oracle Orchestration Layer — Design Spec

Date: 2026-07-16
Status: Approved (phase 1 of the Oracle ecosystem integration effort)

## Problem

The Oracle ecosystem consists of three independently-maintained processes:

- **Oracle** (this repo) — TypeScript CLI/MCP consultant
- **Oracle-memory** — TypeScript MCP server, persistent memory (`.oracle-memory/`)
- **Oracle-messages** — Rust MCP server, multi-agent message bus (`.oracle/messages/`)

Today they interoperate only through a shared on-disk JSON file format: Oracle's
`src/memory/adapter.ts` (`MemoryAdapter`) and `src/peer/mesh.ts` (`MessagesAdapter`)
independently read/write the same directories that `oracle-memory` and
`oracle-messages` read/write, with **no process ever calling another** — no MCP
client relationship, no shared dependency, no cross-repo integration test.

This works for single-command, single-agent use but doesn't scale to real
multi-agent scenarios: e.g. two agents both writing to `.oracle/messages/`
without any process arbitrating means no real-time delivery, no server-side
validation, and features exposed only via the MCP tool surface (search,
pagination, dedup) are unreachable from Oracle's file-adapter path.

## Goal

Make `oracle consult` (and other commands using memory/mesh) *actually* talk to
`oracle-memory` and `oracle-messages` as running MCP servers when possible,
while remaining fully functional with the existing file-adapter behavior when
a server isn't available. The three repos stay independently deployable
(no shared package dependency, no monorepo) — coupling happens at runtime via
process orchestration, not at build time.

## Non-goals

- Not merging the three repos into a monorepo.
- Not requiring users to manually start `oracle-memory`/`oracle-messages` — the
  supervisor spawns them.
- Not changing the on-disk file formats (`.oracle-memory/`, `.oracle/messages/`)
  — both the MCP path and the fallback path continue to operate on the same
  directories, so data is always consistent regardless of which path served a
  given call.
- Not covered by this spec: idea-gathering from external research, and the
  bug-sweep across the four repos. Those are separate follow-on efforts once
  this orchestration layer lands.

## Architecture

```
oracle consult / oracle peer / oracle memory ...
        |
        v
  ProcessSupervisor (new — src/orchestrator/supervisor.ts)
        |
        +--> check ~/.oracle/run/memory.{pid,port}   -> alive? -> connect
        |         missing/dead -> spawn `oracle-memory --transport http --port <auto>`
        |                          (detached, writes pid/port file)
        |
        +--> check ~/.oracle/run/messages.{pid,port} -> alive? -> connect
        |         missing/dead -> spawn `oracle-messages-mcp --transport http --port <auto>`
        |
        v
  MCPClientManager (src/orchestrator/mcp-clients.ts)
        |
        +--> success -> real MCP tool calls (remember/recall, send_message/onboard, ...)
        +--> failure (spawn fail / no binary / timeout / version mismatch)
                  -> log a single warning for the session
                  -> fall back to existing MemoryAdapter / MessagesAdapter (direct file I/O)
```

Spawned servers are **not** tied to the lifetime of a single CLI invocation.
Each spawned process runs as a detached background daemon with an idle-timeout
self-exit (default 10 minutes with no request). This lets multiple concurrent
`oracle consult` invocations — or other agents on the mesh — share one running
server instance, which matters most for `oracle-messages`: it needs to act as
a real central hub for messages to be delivered/visible across agents, not be
killed and respawned per command.

## Components

All new code lives under `Oracle/src/orchestrator/`.

### `supervisor.ts` — `ProcessSupervisor`

```ts
ensureRunning(service: "memory" | "messages"): Promise<
  | { transport: "mcp"; endpoint: string }
  | { transport: "fallback" }
>
```

- Reads `~/.oracle/run/<service>.pid` and `.port`. If present, health-checks the
  existing process (calls a lightweight ping/list tool over HTTP) before
  trusting it — guards against stale lockfiles left by a crashed process.
- If missing or the health-check fails: picks a free local port, spawns the
  service binary detached (`oracle-memory --transport http --port N` /
  the `oracle-messages` MCP binary equivalent), writes fresh pid/port files,
  waits (bounded retry/backoff) for the health-check to pass.
- If spawn itself fails (binary not found, non-zero exit, health-check never
  passes within the timeout budget) returns `{ transport: "fallback" }`.

### `mcp-clients.ts` — `MCPClientManager`

Thin wrapper around the MCP SDK's HTTP client, one per service, exposing
methods matching the actual tool surface needed by the CLI (`remember`,
`recall`, `sendMessage`, `onboard`, etc.) rather than leaking raw MCP
call-tool plumbing into command code.

### `MemoryPort` / `MessagesPort` interfaces

The existing `MemoryAdapter` (`src/memory/adapter.ts`) and `MessagesAdapter`
(`src/peer/mesh.ts`) are kept as-is and become the `FileAdapter` implementation
of a shared interface. A new `McpBackedAdapter` implements the same interface
using `MCPClientManager`. Callers (CLI commands, MCP tool handlers) depend only
on the interface; `ProcessSupervisor`'s result decides which implementation
they get. No caller-visible behavior change beyond "may now be MCP-backed."

## Data Flow Example — `oracle consult --oracle senior-review`

1. Resolve the named oracle profile; it has `--memory` enabled.
2. Call `supervisor.ensureRunning("memory")` → get either `McpBackedAdapter` or
   `FileAdapter`.
3. `adapter.recall(...)` fetches prior insights, injected into the system prompt.
4. After the consult call completes, `adapter.remember(...)` persists a new
   insight.
5. If configured to notify peers, `supervisor.ensureRunning("messages")` then
   `adapter.send(...)` broadcasts the result.
6. Any process this command spawned is left running — the idle-timeout inside
   that process handles eventual shutdown, not this command.

## Error Handling / Fallback Rules

- Spawn failure (binary missing, path wrong) → immediate fallback; warn once
  per CLI session (not once per call, to avoid log spam). `oracle doctor` is
  extended to report per-service status: `mcp (connected)` / `mcp (spawned)` /
  `fallback (reason)`.
- A server that was connected successfully but dies mid-session (e.g. hit its
  own idle timeout right as a new call comes in) → one retry of
  `ensureRunning` (which will attempt a fresh spawn) before falling back.
- Tool-call schema/version mismatch between Oracle's expected MCP tool surface
  and what the running server actually exposes → treated as a connect failure
  → fallback, not a thrown error.
- Because both code paths operate on the identical on-disk format, switching
  between MCP-backed and fallback across separate commands within the same
  project never corrupts or diverges the stored data.

## Testing Plan

- Unit tests for `ProcessSupervisor` with the actual spawn/health-check calls
  mocked (no real process spawn in CI).
- New ecosystem-level integration test: a script that builds all three repos
  and runs `oracle consult --oracle test --memory` for real, then asserts (a) a
  new file appears under `.oracle-memory/insights/`, and (b) the CLI's logged
  transport mode was `mcp`, not `fallback` — proving orchestration actually
  engaged rather than silently falling back.
- Separate fallback-path test: temporarily rename/hide the `oracle-memory`
  binary, rerun the same consult, assert it still succeeds and the logged mode
  is `fallback`.

## Open Follow-ups (out of scope here)

- External research pass for improvement ideas (multi-agent memory/messaging
  patterns from other projects).
- Cross-repo bug sweep now that orchestration exposes the full MCP tool
  surface (search, pagination, dedup) to Oracle's callers for the first time.
