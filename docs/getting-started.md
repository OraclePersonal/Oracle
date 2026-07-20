---
title: Getting Started
---

# Getting Started

## Prerequisites

- Node.js >= 24
- npm
- Codex CLI, Anthropic API key, or OpenAI API key

## Install

```bash
git clone https://github.com/OraclePersonal/Oracle.git
cd Oracle
npm install
npm run build
```

## Configure

```bash
# Codex CLI (default)
codex login

# OR Anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# OR OpenAI
export OPENAI_API_KEY=sk-...
```

## Verify

```bash
node dist/cli.js doctor
```

## Use

```bash
# Ask a question
node dist/cli.js ask "What does ECONNRESET mean?"

# Code review with files
node dist/cli.js ask -f "src/**/*.ts" "Review this for edge cases"

# Multi-turn conversation
node dist/cli.js ask "What causes Redis timeouts?" --conversation redis-1
node dist/cli.js ask "Does that apply to clusters?" --conversation redis-1

# Use a skill
node dist/cli.js consult -p "Find security issues" --skill security

# Autonomous watch mode
node dist/cli.js watch
node dist/cli.js watch --to claude --skill review
```

## Run as MCP server

```bash
node dist/mcp.js
```

Configure in any MCP client:
```json
{"mcpServers":{"oracle":{"command":"node","args":["/path/to/Oracle/dist/mcp.js"]}}}
```