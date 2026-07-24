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
| 🛠️ **Act** | An autonomous agent that reads/writes/edits files and runs shell commands to complete a task. **Shell + filesystem** — confined to the workspace, fully audited (every mutation and command hashed and logged). |
| 📨 **Coordinate** | A file-backed inter-agent message bus. Agents send, receive, reply in threads, broadcast, and track presence — with self-onboarding via MCP server instructions, so no one has to be told how to use it. |
| ✅ **Verify** | A task tracker on top of the bus: assign work with a checklist, log progress, and submit for review — which **blocks** until every checklist item is actually checked off. The task creator is notified automatically. |
| ⏰ **Schedule** | Persistent cron task system — schedule shell commands to run at specific times or intervals. Tasks survive restarts and run via `oracle schedule watch` daemon. |

## Documentation

| # | Doc | Description |
|---|-----|-------------|
| 1 | [Getting Started](getting-started.md) | Install, configure, and verify your setup |
| 2 | [Quick Start](ORACLE_QUICKSTART.md) | Step-by-step MCP setup and first tools |
| 3 | [CLI Reference](cli-reference.md) | Every `oracle` subcommand and flag |
| 4 | [Architecture](architecture.md) | System components, storage layout, provider routing |
| 5 | [Agent & Sandbox](AGENT.md) | The autonomous agent, its constraints, and the audit trail |
| 6 | [MCP Standards](MCP-STANDARDS.md) | Conventions for the MCP tool surface |
| 7 | [Claude Code Usage](CLAUDE_CODE_USAGE.md) | Using Oracle MCP tools within Claude Code |
| 8 | [Setup Checklist](SETUP_CHECKLIST.md) | Verification checklist for MCP setup |
| 9 | [Setup Complete](SETUP_COMPLETE.md) | What was configured and how to test it |
| 10 | [Messaging & Task Tracking](MESSAGING.md) | Inter-agent messaging, wake-up tiers, task workflow |
| 11 | [Scheduler](scheduler.md) | Cron task commands and expressions |
| 12 | [Troubleshooting](troubleshooting.md) | Common issues and how to resolve them |
| 13 | [Superpowers / Specs](superpowers/specs/) | Architecture design specs |
| 14 | [Changelog](/CHANGELOG.md) | Release notes and version history |
| 15 | [Init](getting-started.md#initialize-the-workspace) | Bootstrap `.oracle/` for a new project |

## MCP Tools (49)

Memory (18) · Docs & web (7) · Task tracking (8) · Messaging (8) ·
Consultation & agent (5) · Identity & config (3) · Oracle profiles & skills (4) ·
Session & history (6) · Util (1) · Scheduler (6).

Full tool-by-tool breakdown and the messaging/task-tracking onboarding flow
live in [MESSAGING.md](MESSAGING.md).

## Storage Layout

```
~/.oracle/
├── messages/    # inter-agent message store (atomic JSON per message)
├── tasks/       # task tracker (atomic JSON per task)
├── scheduler/   # cron tasks (atomic JSON per task)
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
