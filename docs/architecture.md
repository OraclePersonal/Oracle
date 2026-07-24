---
title: Architecture
---

# Architecture

```
you ──▶ oracle ask ──▶ context (memory · docs · web · files) ──▶ model ──▶ answer
              │                                                              │
     conversation continuity                                       remembers what it said
              │                                                              │
     memory (facts · insights · wiki · entity graph)  ◀──▶  bus (messages · tasks · presence)
```

Oracle is a single MCP server + CLI, not a set of subprocess microservices —
memory, messaging, and task tracking are all in-process, file-backed stores
under `~/.oracle/`. No database, no daemon.

## Components

| Component | Responsibility | Source |
|---|---|---|
| **CLI** | Commander-based CLI: `ask`, `agent`, `memory`, `wiki`, `docs`, `web`, `msg`, `task`, `identity`, `github`, `session`, `skill` | `src/cli.ts` |
| **MCP Server** | Stdio MCP server exposing 60 tools | `src/mcp/server.ts`, `src/mcp/runtime.ts` |
| **Standalone coordination server** | `oracle-msg-mcp` binary — just `oracle_msg_*` + `oracle_task_*` (14 tools), no provider/memory/agent stack | `src/mcp-messaging.ts` |
| **ConsultService** | Core loop: load files → build context (memory + docs + web) → call provider → answer | `src/core/consult.ts` |
| **Provider layer** | Codex CLI, Anthropic, OpenAI, OpenCode | `src/providers/` |
| **Agent sandbox** | Autonomous file read/write/edit loop with a bash tool for shell commands. Every mutation hashed and logged to an audit trail. | `src/agent/` |
| **Memory system** | BM25 + vector search + entity knowledge graph + auto-consolidation + background maintenance | `src/memory/` |
| **Messaging bus** | Atomic file-backed message store, presence registry, real-time watcher, Stop-hook wake-up | `src/messaging/` |
| **Task tracker** | Plan/assign/verify/report on top of the messaging bus; checklist-gated review | `src/tasks/` |
| **Docs knowledge base** | BM25-indexed local doc retrieval | `src/docs/` |
| **Web providers** | Brave, Tavily, Firecrawl, AgentQL with auto-fallback | `src/web/` |
| **Skills** | Built-in + custom skill loading | `src/skills/` |
| **Wiki** | Compile memory into topic-grouped pages | `src/wiki/` |
| **Soul prompts** | Personality system, loaded from `~/.oracle/souls/` | `src/core/souls.ts` |
| **Identity** | Profile store and persona management | `src/identity/` |
| **GitHub integration** | PR/issue listing, diffs, reviews, comments via `gh` CLI | `src/github/` |

## Inter-agent coordination

Every `oracle-mcp` process and every `oracle msg`/`oracle task` CLI call on
one machine shares the same file-backed bus at `~/.oracle/`. There is no
server to run and no network hop — writes are atomic (tmp file + rename), so
concurrent readers never see a partial message.

**Wake-up has four tiers**, weakest to strongest:

1. **Pull** — an agent calls `oracle_msg_inbox` whenever it wants.
2. **Standby wait** — `oracle_msg_inbox { wait: true }` blocks (up to
   `timeoutSeconds`, max 600) until an unread message lands, then returns it;
   on timeout the agent re-arms. No config — for plain windows told to
   stand by for work.
3. **Push-on-idle** — a Claude Code Stop hook (`scripts/oracle-msg-stop-hook.mjs`)
   blocks the agent from ending its turn while unread messages remain.
4. **Real-time push** — an external watcher types into the agent's tmux pane
   the instant a message lands, waking a fully idle session:
   `scripts/oracle-tmux-launch.sh <agent>` (Claude + watcher in one command)
   or `oracle msg watch --exec "<cmd>"` for a custom nudge.

**Self-onboarding:** the MCP server sends `instructions` to every client on
connect, teaching it to call `oracle_msg_register` and check its task list
before starting work — no human has to explain the flow.

## Task verification gate

`oracle_task_submit` (and its CLI equivalent) refuses to move a task to
`review` if any checklist item created with the task is still unchecked. This
turns "I'm done" from a claim into something that's actually been verified
before the task creator is notified — see [MESSAGING.md](MESSAGING.md#task-planning--tracking-built-on-top-of-messaging)
for the full lifecycle.

## Provider routing

| Provider | Auth |
|---|---|
| codex (default) | Codex CLI login |
| anthropic | `ANTHROPIC_API_KEY` |
| openai | `OPENAI_API_KEY` |
| opencode | `OPENCODE_API_KEY` |

## Storage layout

```
~/.oracle/
├── messages/           # inter-agent message store (atomic JSON per message)
├── tasks/               # task tracker (atomic JSON per task)
├── agents/               # presence registry (one JSON per registered agent)
├── memory/               # facts · insights · wiki · entity graph
├── skills/                # custom skill definitions
├── souls/                 # personality prompts (default/engineer/custom)
├── oracles/               # named oracle profiles (skill+model+provider+memory bundles)
└── sessions/<id>/         # consult history

<project>/
└── .oracle/
    ├── config.json         # per-project include/exclude, provider, model
    ├── docs/                # knowledge base source files
    └── skills/              # project-local skill overrides
```

## Security model

The agent sandbox has a **bash tool** for running shell commands, confined to the
workspace root with a timeout and audit trail. Every mutation is logged with a timestamp,
agent name, SHA-256 content hash, and diff summary, so file changes and commands can be
audited or reverted after the fact. The bash tool is disabled in readOnly mode.

The message bus and task store are plain local JSON files with no
encryption — suitable for single-machine multi-agent coordination, not for
sending messages across a network.

---
*Oracle — A persistent coordination layer for AI coding agents*
*https://github.com/OraclePersonal/Oracle*
