# Oracle

**MCP-powered AI coding consultant** — skills, named oracles, memory layer, and peer mesh.

```
CLI + MCP server → bundle project context → analyze with AI → persist sessions
                   Skills | Oracles | Memory (oracle-memory) | Mesh (oracle-messages)
```

## Requirements

- Node.js 24+
- One provider: Codex CLI (`codex login`), OpenAI key (`OPENAI_API_KEY`), or
  Anthropic key (`ANTHROPIC_API_KEY` / OAuth)

## Quick start

```bash
npm install && npm run build

# Check provider
node dist/cli.js doctor

# Consult
node dist/cli.js consult -p "Review this code" -f "src/**/*.ts"
```

## CLI

```
oracle consult   -p <prompt> [--skill <name>] [--oracle <name>] [--diff [target]] [-f <pattern...>]
oracle doctor    [--provider <name>]
oracle oracle    list|register|unregister|show
oracle memory    list|clear
oracle skill     list|install <file.json>
oracle peer      export|import|send|list|monitor
oracle login     [--provider anthropic] [--client-id <id>]
oracle logout
oracle session   <id>
oracle status    [-n <limit>]
oracle setup-mcp [--client claude-code|codex]
```

### consult

```bash
# Basic
oracle consult -p "Review for edge cases" -f "src/**/*.ts"

# With skill
oracle consult -p "Find bugs" --skill debug

# With named oracle (auto-loads skill + memory)
oracle consult --oracle senior-review -p "Review this PR"

# With git diff context (default: HEAD~1)
oracle consult -p "Review changes" --diff
oracle consult -p "Review against main" --diff main

# With vision (image files auto-detected)
oracle consult -p "What does this diagram show?" -f "diagram.png"

# With multi-turn
oracle consult -p "Follow up question" --previous-session-id <id>
```

### Skills

5 built-in: `review`, `debug`, `architecture`, `tests`, `security`

```bash
oracle skill list
oracle skill install ./my-skill.json
```

Custom skill format (`~/.oracle/skills/<name>.json`):
```json
{
  "name": "my-skill",
  "description": "Focus on error handling",
  "systemPrompt": "Analyze error handling, edge cases, and logging coverage...",
  "filePatterns": ["src/**/*.ts"],
  "model": "claude-sonnet-4-20250514"
}
```

### Named Oracles

```bash
# Register
oracle oracle register --name senior-review --skill review --memory
oracle oracle register --name debugger --skill debug --model claude-sonnet-4-20250514

# List
oracle oracle list

# Consult with oracle (auto-injects memory context)
oracle consult --oracle senior-review -p "Review this"
```

When `--memory` is enabled, each consult saves a summary (`insight`) via
[oracle-memory](https://github.com/JonusNattapong/oracle-memory) (`.oracle-memory/` format). Past
insights are injected into the system prompt on subsequent calls.

### Providers

| Provider | Auth | Env var |
|----------|------|---------|
| `codex` (default) | `codex login` | — |
| `openai` | API key | `OPENAI_API_KEY` |
| `anthropic` | API key or OAuth | `ANTHROPIC_API_KEY` / `ANTHROPIC_CLIENT_ID` |

```bash
oracle login --provider anthropic --client-id <id>
oracle consult -p "Review" --provider anthropic --model claude-sonnet-4-20250514
```

### Peer mesh (oracle-messages)

Messages are stored in `.oracle/messages/` format, compatible with
[oracle-messages](https://github.com/JonusNattapong/oracle-messages) message bus.

```bash
oracle peer send --to claude --body "Review complete" --kind review-result
oracle peer list --agent oracle --limit 10
oracle peer monitor --agent oracle
oracle peer export senior-review -o oracle.json
oracle peer import oracle.json
```

### Memory (oracle-memory)

Memory entries stored in `.oracle-memory/` format, compatible with
[oracle-memory](https://github.com/JonusNattapong/oracle-memory) memory server.

```bash
oracle memory list
oracle memory list --agent senior-review
oracle memory clear
oracle memory clear senior-review
```

## MCP Server

```bash
# Start directly
node dist/mcp.js

# Generate client config
oracle setup-mcp --client claude-code
oracle setup-mcp --client codex
```

### MCP tools (14)

| Tool | Description |
|------|-------------|
| `oracle_consult` | Analyze project files with a skill |
| `oracle_skills` | List available skills |
| `oracle_oracle_list` | List registered oracle profiles |
| `oracle_oracle_register` | Create a named oracle |
| `oracle_memory_list` | List memory entries from `.oracle-memory` |
| `oracle_memory_clear` | Clear working memory |
| `oracle_sessions` | List recent sessions |
| `oracle_session_get` | Get session details |
| `oracle_doctor` | Check configuration and provider |

## Configuration

`.oracle/config.json`:
```json
{
  "provider": "codex",
  "model": "gpt-5.4",
  "include": ["src/**/*", "README.md", "package.json"],
  "exclude": ["**/*.test.ts", "**/dist/**"],
  "maxFileSizeBytes": 1000000,
  "maxInputBytes": 5000000
}
```

## Storage layout

```
~/.oracle/
├── oracles/         # Named oracle profiles
├── skills/          # Custom skill files
├── sessions/        # Consult session history
│   └── <id>/
│       ├── bundle.md
│       ├── output.md
│       └── session.json
├── auth/            # OAuth tokens
│   └── anthropic.json

<project>/
├── .oracle/
│   ├── config.json
│   ├── workshop.json
│   └── skills/      # Project-local skills
├── .oracle-memory/  # Memory (compatible with oracle-memory)
│   ├── facts/
│   ├── insights/
│   ├── chunks/
│   └── working/
└── .oracle/messages/ # Messages (compatible with oracle-messages)
    └── messages/
```

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `ORACLE_HOME_DIR` | `~/.oracle` | Home for config, skills, oracles, sessions |
| `ORACLE_WORKSPACE_ROOT` | `cwd` | MCP workspace root |
| `OPENAI_API_KEY` | — | OpenAI provider |
| `ANTHROPIC_API_KEY` | — | Anthropic provider |
| `ANTHROPIC_CLIENT_ID` | — | Anthropic OAuth client ID |
| `ORACLE_MEMORY_ROOT_DIR` | `cwd` | Memory root (oracle-memory compatible) |

## Integrated projects

Oracle reads/writes `.oracle-memory/` and `.oracle/messages/` formats natively,
making it interoperable with:

- [Oracle Memory](https://github.com/JonusNattapong/oracle-memory) — Persistent memory layer
- [Oracle Messages](https://github.com/JonusNattapong/oracle-messages) — Multi-agent message bus
