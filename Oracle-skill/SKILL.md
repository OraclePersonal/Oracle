---
name: oracle
description: Use when acting as an AI agent (Claude, Codex, Gemini, or any coding agent) that needs to coordinate with other agents and persist knowledge across sessions via the Oracle stack — covers oracle-messages (multi-agent message bus, tasks, threads) and oracle-memory (fact/insight/chunk/working memory). Trigger on session start in any multi-agent workspace, or whenever the task involves sending/receiving agent messages, claiming tasks, or remembering/recalling project knowledge.
---

# Oracle Skill

Unified workflow for any AI agent using the **Oracle stack**:

- **oracle-messages** — file-backed MCP message bus for agent-to-agent coordination (identity, threads, tasks).
- **oracle-memory** — file-backed MCP memory server for persistent knowledge across sessions (facts, insights, chunks, working memory).

Both are optional MCP servers. Detect which are connected before using them — do not assume both are present.

## 0. Detect what's available

At the start of any session in a multi-agent workspace:

1. Check connected MCP servers for `oracle` (messages) and `oracle-memory`.
2. If neither is connected, this skill does not apply — proceed normally.
3. If only one is connected, use only that half of the flow below.

## 1. Session-start sequence

Run in this order — memory first (context), then messages (coordination):

```
1. oracle-memory.recall(query="project context", limit=5)
      → surface recent facts/insights before doing anything else

2. oracle.onboard(name="<your_name>", role="<optional>")
      → registers identity, joins roster, returns:
        - open_threads (unresolved openers aimed at you)
        - unread (messages since your cursor)
        - next (hint for what to do next)

3. Resolve every open_thread via reply_to_message before starting new work.
4. Review unread messages.
```

If `onboard` is unavailable, do the long form instead:
`register_identity(name, role)` → `get_status()` → `list_open_threads(agent=name)`.

Pick a **stable name** (e.g. `claude`, `codex`, `gemini`) and reuse it across both servers and across sessions — memory and messages are both keyed by agent name, and a name change silently forks your history in both.

## 2. Core dev loop

This is the loop you stay in for the rest of the session. Never exit it just because you're idle — block and wait instead.

```
                    ┌─────────────────────────────────────────┐
                    │              CORE DEV LOOP                │
                    └─────────────────────────────────────────┘

  list_open_threads(agent=me) ──► wait_for_message(agent=me, timeout=30, max_retries=10)
                                            │
                                    message arrives
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    │                       │                       │
              opener kind?             plain message            task-related
        (question/review-request/       reply if useful         (kind=task or
         proposal) → must resolve                                 sidecar)
                    │                                               │
            reply_to_message                              transition_task(
                    │                                        assign/in_progress/
                    │                                        completed/failed)
                    │                                               │
                    └───────────────────┬───────────────────────────┘
                                         │
                         did you learn something worth keeping?
                                         │
                              ┌──────────┴──────────┐
                              │                      │
                        yes → remember()        no → skip
                    (fact = permanent,
                     insight = lesson learned)
                                         │
                                         ▼
                        wait_for_message again — LOOP.
             Empty result = "no message YET", not "session over".
```

Rules that keep the flow from breaking:

- **Never stop on an empty `wait_for_message`.** Call it again immediately. Only stop when the human says stop, or you receive `kind=end`.
- **Always resolve openers.** A `question`/`review-request`/`proposal` addressed to you is a promise to reply — leaving it open breaks the thread view for every other agent.
- **Prefer `reply_to_message` over `send_message`** when responding — it auto-fills `parent_id`, `in_reply_to`, recipient, and reply kind, so threads stay linked.
- **Use `create_task`/`transition_task`** instead of ad-hoc messages for anything with a lifecycle (assign → in_progress → completed/failed/cancelled) — it gives every agent a queryable state instead of free text.

## 3. When to write memory

Write memory at natural checkpoints, not after every message — over-writing chunks defeats the purpose.

| Trigger | Type | Example |
|---|---|---|
| You learn a durable project fact | `fact` | "Config lives in `.oracle/config.json`, not env vars" |
| You discover a bug, gotcha, or workaround | `insight` | "`wait_for_message` blocks up to 5 min per call — don't poll in a tight loop" |
| Before `/compact` or session end | `chunk` (with `ttl`) | Summary of what was discussed, so the next session can `recall` it |
| Scratch state for the current task only | `working` | Intermediate plan, not meant to survive the session |

Always pass your agent name in `agent`. Tag generously — tags drive the entity graph and `consolidate()` merges.

At session end (or before a long idle stretch): `clear_working(agent=me)` so stale scratch state doesn't leak into the next session's `recall`.

## 4. Full loop, both servers combined

```
SESSION START
  │
  ├─► recall(query="project context")           [oracle-memory]
  │
  ├─► onboard(name, role)                        [oracle-messages]
  │     → open_threads, unread, next
  │
  ├─► resolve open_threads via reply_to_message
  │
  ▼
┌─────────────── CORE LOOP (repeat until stop signal) ───────────────┐
│                                                                     │
│  wait_for_message(agent=me, timeout=30, max_retries=10)            │
│         │                                                          │
│         ▼                                                          │
│  parse: sender, kind, subject, body, parent_id                     │
│         │                                                          │
│  is opener? ──yes──► do the work ──► reply_to_message               │
│         │no                                                        │
│         ▼                                                          │
│  is task? ────yes──► transition_task(...)                          │
│         │no                                                        │
│         ▼                                                          │
│  learned something durable? ──yes──► remember(fact|insight)        │
│         │no                                                        │
│         ▼                                                          │
│  new initiative of your own? ──yes──► send_message / broadcast     │
│         │                                                          │
│         └──────────────────► loop back to wait_for_message          │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
  │
  ▼
SESSION END / before /compact
  ├─► remember(type="chunk", content="session summary", ttl=604800)
  └─► clear_working(agent=me)
```

## 5. Reference — tool surfaces

### oracle-messages (agent bus)

| Category | Tools |
|---|---|
| Identity | `onboard`, `register_identity`, `get_status`, `get_agent_instructions` |
| Roster | `list_agents`, `add_agent`, `retire_agent`, `set_agent_role`, `set_agent_group` |
| Messaging | `send_message`, `broadcast`, `wait_for_message`, `sync_messages`, `get_message`, `search_messages`, `get_thread`, `list_open_threads`, `reply_to_message`, `delete_message` |
| Cursors | `advance_cursor` |
| Tasks | `create_task`, `transition_task`, `get_task`, `list_tasks` |
| Cards/channels | `set_agent_card`, `get_agent_card`, `find_agents`, `subscribe`, `unsubscribe` |
| Server | `start_server`, `stop_server`, `server_status` |
| Resources | `oracle://instructions`, `oracle://roster`, `oracle://messages`, `oracle://threads/open`, `oracle://agent/{name}/unread`, `oracle://message/{id}`, `oracle://thread/{id}` |
| Prompts | `standup`, `triage_unread`, `handoff`, `review_request` |
| Benchmarks | `cargo run --release --bin oracle-bench` → SVG at `bench/results.svg` |

Message kinds that open a thread requiring resolution: `question`, `review-request`, `proposal`. Close with a matching reply or an explicit closer.

On-disk store: `.oracle/{config.json, messages/<id>.json, state/<agent>.cursor, tasks/<msg_id>.json, sessions/<session>.json}`.

### oracle-memory (persistent knowledge)

| Tool | Purpose |
|---|---|
| `remember` | Save a memory (`fact`/`insight`/`chunk`/`working`) |
| `recall` | Hybrid search (BM25 + vector + entity graph) |
| `get_memory` | Fetch one memory by id + type |
| `update_memory` | Edit content/tags/importance/ttl, re-indexes |
| `list_memories` | Browse/filter by type, agent, tags, query |
| `forget` | Permanently delete by id + type |
| `clear_working` | Clear an agent's (or all) working memory |
| `consolidate` | Merge similar memories by tag overlap |
| `get_sessions` | Connected agent sessions (HTTP transport) |
| `get_stats` | Counts by type/agent |
| Resources | `oracle-memory://memories`, `oracle-memory://memories/{type}`, `oracle-memory://stats`, `oracle-memory://sessions` |

On-disk store: `.oracle-memory/{facts,insights,chunks,working}/`.

Retention: `fact`/`insight` are permanent until `forget`; `chunk` expires via `ttl` (background sweep every 5 min); `working` clears on `clear_working` / session end.

## 6. Setup (once per workspace)

For a single server, the quick version:

```bash
# oracle-messages — build + register (stdio, single agent)
git clone https://github.com/JonusNattapong/oracle-messages
cd oracle-messages && cargo build --release
claude mcp add oracle -- /abs/path/to/target/release/oracle

# oracle-memory — stdio
claude mcp add oracle-memory -- node /abs/path/to/oracle-memory/dist/index.js
```

For multi-agent hubs (Claude Code, Codex, Gemini CLI, web LLMs sharing one bus/memory), run both servers with `*_TRANSPORT=http` and register each client against the shared HTTP endpoint instead of stdio. See each project's own AGENT(S).md for Docker and WebSocket options.

### 6.1 Full ecosystem install

Trigger this whole section whenever asked to set up, install, or bootstrap "the whole Oracle stack/ecosystem" from scratch. The stack is four independent repos — clone them as siblings under one parent directory:

```
oracle-ecosystems/
  Oracle/           # CLI + built-in oracle_* MCP tools (Node/TypeScript)
  Oracle-memory/     # standalone oracle-memory MCP server (Node/TypeScript)
  Oracle-messages/   # standalone oracle-messages MCP server + LAN P2P (Rust)
  Oracle-skill/       # this file — the cross-agent workflow doc
```

**Prerequisites:** Node.js ≥ 24, Rust + cargo (stable), git.

**Step 1 — clone.**

```bash
mkdir oracle-ecosystems && cd oracle-ecosystems
git clone https://github.com/JonusNattapong/Oracle
git clone https://github.com/JonusNattapong/Oracle-memory
git clone https://github.com/JonusNattapong/oracle-messages
git clone https://github.com/JonusNattapong/Oracle-skill
```

**Step 2 — build each.**

```bash
(cd Oracle && npm install && npm run build)
(cd Oracle-memory && npm install && npm run build)
(cd Oracle-messages && cargo build --release)
```

**Step 3 — register MCP servers, using absolute paths.**

> ⚠️ **Name collision:** Oracle CLI's own binary (`npm bin: oracle`) and oracle-messages' Rust binary (`cargo bin: oracle`) are **both literally named `oracle`**. Do not `npm link` the CLI and also put `Oracle-messages/target/release/` on `PATH` — whichever lands last on `PATH` silently shadows the other. Registering MCP servers by **absolute path** (as below) sidesteps this entirely; only use `npm link` / `cargo install --path .` for one of the two, never both.

```bash
# This repo's own built-in oracle_* tools (consult/memory/identity/peer mesh in one server)
(cd Oracle && oracle setup-mcp --client claude-code)
# — or, without npm link, register the built server directly:
claude mcp add oracle-cli -- node /abs/path/to/oracle-ecosystems/Oracle/dist/mcp.js

# oracle-messages (Rust binary, absolute path — avoids the name collision above)
claude mcp add oracle-bus -- /abs/path/to/oracle-ecosystems/Oracle-messages/target/release/oracle

# oracle-memory (Node, absolute path)
claude mcp add oracle-memory -- node /abs/path/to/oracle-ecosystems/Oracle-memory/dist/index.js
```

**Step 4 — install this skill.** Copy (or symlink) this file so the workflow in sections 1–5 auto-loads for the agent:

```bash
# User-wide (all projects)
mkdir -p ~/.claude/skills/oracle
cp oracle-ecosystems/Oracle-skill/SKILL.md ~/.claude/skills/oracle/SKILL.md

# Or project-scoped instead
mkdir -p ./.claude/skills/oracle
cp oracle-ecosystems/Oracle-skill/SKILL.md ./.claude/skills/oracle/SKILL.md
```

**Step 5 — verify.**

1. Restart/reopen the client so it re-reads MCP config.
2. Confirm all three servers show as connected (`oracle-cli`, `oracle-bus`, `oracle-memory`) — ask the agent to list connected MCP servers, or run `oracle_doctor` if the built-in server is registered.
3. Smoke-test the bus: `onboard(name="smoke-test")` → `send_message(to="smoke-test", body="ping")` → `wait_for_message(agent="smoke-test")` should return the ping immediately.
4. Smoke-test memory: `remember(agent="smoke-test", type="fact", content="install verified")` → `recall(query="install verified")` should return that entry.
5. *(Optional)* Run the oracle-messages benchmark suite (`cd oracle-messages && cargo run --release --bin oracle-bench`) — opens `bench/results.svg` in the same bar-chart format as oracle-memory.
6. If either smoke test fails, re-check Step 3's absolute paths — this is the most common install issue (a relative or stale path in the MCP config).

**Step 6 — optional: environment variables for HTTP/multi-host mode.** Default is stdio (single local agent, nothing to configure). For a shared hub multiple agents or machines connect to:

| Var | Server | Purpose |
|---|---|---|
| `ORACLE_MEMORY_TRANSPORT=http` | oracle-memory | Switch from stdio to HTTP |
| `ORACLE_MEMORY_PORT` | oracle-memory | HTTP port (default `8765`) |
| `ORACLE_MEMORY_HTTP_TOKEN` | oracle-memory | Bearer auth for the HTTP endpoint |
| `ORACLE_TRANSPORT=http` | oracle-messages | Switch from stdio to HTTP/SSE |
| `ORACLE_P2P_TOKEN` | oracle-messages | Bearer auth for LAN peer-to-peer direct delivery |
| `ORACLE_PEERS` | oracle-messages | Manually register agents UDP LAN broadcast can't reach (different subnet, cloud host, VPN): `name1=http://host1:port1,name2=http://host2:port2` — messages to these agents still deliver via the durable store even without this, but setting it restores instant push instead of waiting for the next poll |
| `ANTHROPIC_API_KEY` (or `oracle login`) | Oracle CLI | Model provider auth for `oracle_consult` |

Messages are always written to the durable file store before any real-time push is attempted — even with none of the above set, no message is ever lost due to a peer being offline or unreachable; delivery just becomes poll-based instead of instant.

**Step 3 alternative — let Oracle CLI auto-manage memory/messages itself.** Instead of registering `oracle-bus`/`oracle-memory` as separate MCP servers, Oracle CLI's own built-in server (`oracle-cli` from Step 3) can spawn and proxy both automatically on first use — just `oracle setup-mcp` and skip the other two `claude mcp add` calls. This needs one more env var, because oracle-messages' cargo bin is literally named `oracle` (the collision noted above) and has no safe default bare-command name to auto-spawn:

| Var | Purpose |
|---|---|
| `ORACLE_MESSAGES_BIN` | Absolute path to the built oracle-messages binary (e.g. `.../Oracle-messages/target/<triple>/release/oracle`) — required for auto-managed messages to work at all |
| `ORACLE_MEMORY_BIN` | Absolute path override for oracle-memory, if its default `oracle-memory` isn't on `PATH` |

Set these once (shell profile, or in the `env` block Step 3 writes to `.mcp.json`/`config.toml`) before relying on auto-managed mode.

## 7. Windows note

If running oracle-messages tooling from custom scripts on Windows, force UTF-8 explicitly (`open(path, 'w', encoding='utf-8')` in Python, `fs.writeFileSync(path, data, 'utf-8')` in Node, `chcp 65001` in shells) — the default console code page mangles non-ASCII agent content otherwise. `oracle-mcp` itself already does this at startup.

## Red flags — you're breaking the flow

| Thought | Reality |
|---|---|
| "wait_for_message came back empty, I'm done" | Empty means "not yet" — call it again |
| "I'll just send_message instead of replying" | Loses thread linkage — use `reply_to_message` for anything with a `parent_id` |
| "I'll skip recall, I remember this project" | Your context resets between sessions; the store doesn't |
| "I'll remember every message" | Floods memory — only `fact`/`insight` on durable learnings, `chunk` at checkpoints |
| "Different name this session is fine" | Forks your roster identity and memory history — keep one stable name |
