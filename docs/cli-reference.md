# Oracle CLI Reference

Single-page reference for every `oracle` subcommand. Each command maps to
one or more MCP tools of the same name.

## Global flags

```
-V, --version    output the version number
-h, --help       display help for command
```

## Commands

### oracle ask

Ask Oracle anything with full project context.

```bash
oracle ask "Why is service X timing out?"
oracle ask "review this" -f "src/**/*.ts"
oracle ask "what's in our latest PR?" --include-gh
oracle ask "review" --soul engineer
```

| Flag | Purpose |
|---|---|
| `-f, --files <glob>` | Include code files (supports `!exclude` patterns) |
| `--include-docs` | Inject `.oracle/docs/` knowledge base |
| `--include-gh` | Include GitHub PR/issue context |
| `--soul <name>` | Personality: `engineer`, `socratic`, `witty`, etc. |
| `--conversation <id>` | Multi-turn: recall prior answers in same conversation |
| `--scope <project\|global>` | Memory scope (default: project) |
| `--json` | Output structured JSON |

---

### oracle agent

Autonomous coding loop — reads, writes, edits files, runs shell commands.

```bash
oracle agent "add a --verbose flag and update the README"
oracle agent "refactor auth" --plan --yes
oracle agent "fix login bug" --review
oracle agent "add validation" --json
oracle agent "continue" --resume cp-20260723-...
oracle agent "investigate" --read-only
```

| Flag | Purpose |
|---|---|
| `--plan` | Read-only investigation pass, then confirm before executing |
| `--yes` | Skip confirmation prompt when using `--plan` |
| `--review` | Self-review pass after completion |
| `--resume <id>` | Resume from a saved checkpoint |
| `--json` | Structured output with `finalText`, `steps`, `checkpointId` |
| `--read-only` | No mutations; read-only investigation |
| `--max-steps <n>` | Cap the loop (default 20, max 50) |
| `--provider <name>` | Override provider for this run |
| `--model <name>` | Override model for this run |

Related: `oracle agent-checkpoints` — list or delete checkpoints.

---

### oracle memory

Persistent memory management.

```bash
oracle memory remember "Dashboard uses connection pool Y"
oracle memory search "connection pool"
oracle memory list
oracle memory stats
oracle memory consolidate
oracle memory prune --days 30
oracle memory promote <id>
```

---

### oracle wiki

Compile memory into topic-grouped wiki pages.

```bash
oracle wiki build "auth"
oracle wiki list
oracle wiki get "auth"
```

---

### oracle docs

Manage `.oracle/docs/` knowledge base.

```bash
oracle docs list
oracle docs add README.md
oracle docs search "deployment"
oracle docs remove old-guide.md
```

---

### oracle web

Web search, fetch, and structured extraction.

```bash
oracle web search "Redis timeout causes"
oracle web fetch https://example.com/api-docs
oracle web extract https://example.com/pricing --schema price
```

Providers: Brave, Tavily, Firecrawl, AgentQL (auto-fallback).

---

### oracle msg

Inter-agent message bus.

```bash
oracle msg send -f lead -t builder -b "start the task"
oracle msg send -f lead -t "*" -b "team standup in 5"
oracle msg inbox -a builder
oracle msg inbox -a builder --wait --timeout 120
oracle msg ack -a builder <id>
oracle msg agents
oracle msg thread --reply-to <id> -b "done"
oracle msg watch -a builder --exec 'notify-send "msg from $ORACLE_MSG_FROM"'
```

---

### oracle task

Task planning, tracking, and verification.

```bash
oracle task create --title "Add rate limiter" --created-by lead --assignee builder \
  --checklist "implement" "add tests" "update docs"
oracle task list --assignee builder --active
oracle task get <id>
oracle task update <id> -a builder --status in_progress --note "starting"
oracle task check <id> 0                          # check off item 0
oracle task submit <id> -a builder --summary "done"
oracle task close <id> -a lead                    # approve
oracle task close <id> -a lead --reject --note "..."  # reject
oracle task board --created-by lead
```

---

### oracle schedule

Cron task scheduler.

```bash
oracle schedule list
oracle schedule add --name "daily-backup" --expr "0 2 * * *" --cmd "tar czf /tmp/backup.tgz src/"
oracle schedule run <id>            # run once immediately
oracle schedule watch               # start persistent daemon
oracle schedule remove <id>
```

---

### oracle swarm

Autonomous multi-agent swarm workflow.

```bash
oracle swarm --plan "Build the dashboard feature" \
  --agents "lead:planner,fetcher:builder,tester:tester"
```

---

### oracle audit

View agent audit trail and policy violations.

```bash
oracle audit --agent <name>
oracle audit --since 2026-07-20
```

---

### oracle identity

Manage your personal identity profile.

```bash
oracle identity setup
oracle identity show
```

---

### oracle skill

Manage skills.

```bash
oracle skill list
oracle skill info <name>
```

---

### oracle doctor

Verify installation, config, and provider health.

```bash
oracle doctor
```

---

### oracle setup-mcp

Generate MCP config for a client.

```bash
oracle setup-mcp --client claude-code
```

---

### oracle login / logout

OAuth authentication.

```bash
oracle login --provider anthropic
oracle logout --provider anthropic
```

---

### oracle session

View consultation history.

```bash
oracle session <id>
```

---

### oracle oracle

Manage oracle profiles (skill + model + memory bundles).

```bash
oracle oracle list
oracle oracle register --name coding --skill review --model auto
```

---

### oracle github

GitHub integration via `gh` CLI (requires `gh auth status`).

```bash
oracle github pr list --repo owner/repo
oracle github pr get 42 --repo owner/repo
oracle github pr diff 42 --repo owner/repo
oracle github pr review 42 --repo owner/repo --approve
```

---
*Oracle — A persistent coordination layer for AI coding agents*
*https://github.com/OraclePersonal/Oracle*
