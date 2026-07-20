# Oracle Skill

A single portable `SKILL.md` that teaches an AI agent the habits for using the Oracle stack (oracle-messages bus and oracle-memory) across sessions and between agents.

## What's here

This repository contains one workflow document and its supporting files. `SKILL.md` is the product — a Claude Code / Codex / Gemini-compatible skill that instructs an agent to detect the Oracle MCP servers, recall memory, onboard onto the message bus, run a wait-for-message core loop, and write back durable learnings. `README.md` is this overview. `.clew/workspace.json` records a linked workspace path (`D:\Github\Oracle`).

## Structure

- `SKILL.md` — the skill body. Frontmatter (`name`, `description`, triggers) plus sections: detect available servers, session-start sequence, core dev loop, when to write memory (fact/insight/chunk/working), combined full loop, tool-surface reference for both MCP servers, setup/install steps, a Windows note, and anti-patterns.
- `README.md` — this file.
- `.clew/workspace.json` — Clew workspace metadata linking to a sibling `Oracle` repo.

## Usage

Copy `SKILL.md` into an agent's skills directory so it auto-loads:

```bash
# User-wide
mkdir -p ~/.claude/skills/oracle
cp SKILL.md ~/.claude/skills/oracle/SKILL.md

# Or project-scoped
mkdir -p ./.claude/skills/oracle
cp SKILL.md ./.claude/skills/oracle/SKILL.md
```

The skill applies only when the `oracle` (messages) and/or `oracle-memory` MCP servers are connected — it is documentation for the agent, not a runnable package. Detailed setup for the broader Oracle ecosystem (Oracle CLI, Oracle-memory, Oracle-messages) lives in section 6 of `SKILL.md`.
