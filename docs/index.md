---
title: Oracle
---

# Oracle

**A persistent coordination layer for AI coding agents** — not a database, not a
replacement for your agent, but a shared teammate that remembers everything and
keeps everyone on the same page.

A stateless coding agent forgets everything the moment a session ends. Two
agent sessions running in parallel can't talk to each other. Getting an agent
to actually *act* — not just suggest — usually means babysitting every file
change.

Oracle is an MCP server + CLI that any agent (Claude Code, opencode, Codex,
Gemini CLI, …) wires into to fix that.

## Quick Start

```bash
npm install -g @oraclepersonal/oracle
oracle doctor                          # verify a provider is wired up
oracle setup-mcp --client claude-code  # wire the MCP server into Claude Code
```

Or without installing:
```bash
npx -p @oraclepersonal/oracle oracle ask "review this" -f "src/**/*.ts"
```

## The Five Pillars

| Pillar | What it does |
|---|---|
| 🧠 **Remember** | Persistent memory across sessions, auto-ranked by recency, frequency, semantic match, and importance. Entity graph links related knowledge. Auto-consolidation kills duplicates. |
| 💬 **Consult** | Ask a question with real project context — code files, memory, docs, web search/fetch — and get a grounded, cited answer. |
| 🛠️ **Act** | An autonomous agent that reads/writes/edits files to complete a task. **No shell** — filesystem-only, fully audited (every mutation hashed and logged). |
| 📨 **Coordinate** | A file-backed inter-agent message bus. Agents send, receive, reply in threads, broadcast, and track presence — with self-onboarding via MCP server instructions, so no one has to be told how to use it. |
| ✅ **Verify** | A task tracker on top of the bus: assign work with a checklist, log progress, and submit for review — which **blocks** until every checklist item is actually checked off. The task creator is notified automatically. |

## Documentation

| Doc | Description |
|-----|-------------|
| [Architecture](architecture.md) | System components, storage layout, provider routing |
| [Getting Started](getting-started.md) | Install, configure, and run |
| [Agent & Sandbox](AGENT.md) | The autonomous agent, its constraints, and the audit trail |
| [MCP Standards](MCP-STANDARDS.md) | Conventions for the MCP tool surface |

## MCP Tools (60)

Memory (18) · GitHub integration (11) · Docs & web (7) · Task tracking (7) ·
Messaging & coordination (6) · Consultation & agent (5) · Identity & config (3)
· Oracle profiles & skills (3).

Full tool-by-tool breakdown, CLI reference, and the messaging/task-tracking
onboarding flow live in
[MESSAGING.md](https://github.com/OraclePersonal/Oracle/blob/main/MESSAGING.md)
and the main [README](https://github.com/OraclePersonal/Oracle#readme).

## Storage Layout

```
~/.oracle/
├── messages/    # inter-agent message store (atomic JSON per message)
├── tasks/       # task tracker (atomic JSON per task)
├── agents/      # presence registry
├── memory/      # persistent memory: facts, insights, wiki, entity graph
├── skills/      # local skill definitions
└── souls/       # personality prompts (default/engineer/custom)
```

## Why "Oracle"?

An oracle is something you *consult* — it remembers, it knows, and it
answers. This project is that for your agents: a shared source of truth
they return to across sessions, and a switchboard they use to reach each
other. It's provider-neutral (any model backend) and agent-neutral (any MCP
client) — it sits *beside* your coding agent, not instead of it.

## License

MIT. Not affiliated with Oracle Corp or the Oracle database.
