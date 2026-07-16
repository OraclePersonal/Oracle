# Oracle

> A senior engineer you can summon with one command. It reads your code, thinks with a real model, remembers what it learned, and can talk to other agents while it works.

**Oracle** is an MCP-powered AI coding consultant. Point it at some files, ask a question, and it bundles the right context, sends it to the model of your choice (Codex, OpenAI, or Anthropic), and hands back a real review — not a vibe. Give it a **skill** to sharpen its focus, a **named oracle** to give it a personality and a memory, and a **peer mesh** so it can coordinate with your other agents.

```
   you ──▶ oracle consult ──▶ bundle context ──▶ think (AI) ──▶ answer
                  │                                              │
            skills · oracles                              saved as a session
                  │                                              │
        memory (oracle-memory)  ◀───────────────────────▶  mesh (oracle-messages)
```

---

## Meet the family

Oracle is the brain. It's happiest with its two siblings, but works fine alone:

- 🧠 **[oracle-memory](https://github.com/JonusNattapong/oracle-memory)** — the notebook it never forgets.
- 📮 **[oracle-messages](https://github.com/JonusNattapong/oracle-messages)** — the group chat where agents coordinate.
- 📖 **[oracle-skill](https://github.com/JonusNattapong/oracle-skill)** — the manual that teaches *any* agent how to use the two above.

Oracle reads and writes their on-disk formats (`.oracle-memory/`, `.oracle/messages/`) directly, so everything interoperates with zero glue code.

---

## 60-second start

You need **Node.js 24+** and **one** provider:

| Provider | How to authenticate | Env var |
|----------|---------------------|---------|
| `codex` *(default)* | `codex login` | — |
| `openai` | API key | `OPENAI_API_KEY` |
| `anthropic` | API key **or** OAuth | `ANTHROPIC_API_KEY` / `ANTHROPIC_CLIENT_ID` |

```bash
npm install && npm run build

# Is anyone home? (checks your provider is wired up)
node dist/cli.js doctor

# Ask the oracle something real
node dist/cli.js consult -p "Review this for edge cases" -f "src/**/*.ts"
```

That's it. The oracle gathers the files, thinks, and answers.

---

## The one command you'll actually use: `consult`

```bash
# Plain review
oracle consult -p "Review for edge cases" -f "src/**/*.ts"

# Sharpen the focus with a skill
oracle consult -p "Find bugs" --skill debug

# Summon a named oracle (auto-loads its skill + memory)
oracle consult --oracle senior-review -p "Review this PR"

# Feed it a git diff instead of whole files
oracle consult -p "Review my changes" --diff          # default: HEAD~1
oracle consult -p "Review against main" --diff main

# It has eyes, too — images are auto-detected
oracle consult -p "What does this diagram show?" -f "diagram.png"

# Keep the conversation going
oracle consult -p "Follow-up question" --previous-session-id <id>
```

Every consult is saved as a **session** you can revisit (`oracle session <id>`, `oracle status`).

---

## Skills — give the oracle a specialty

Five come built in: `review`, `debug`, `architecture`, `tests`, `security`.

```bash
oracle skill list
oracle skill install ./my-skill.json
```

Roll your own (`~/.oracle/skills/<name>.json`):

```json
{
  "name": "my-skill",
  "description": "Focus on error handling",
  "systemPrompt": "Analyze error handling, edge cases, and logging coverage...",
  "filePatterns": ["src/**/*.ts"],
  "model": "claude-sonnet-4-20250514"
}
```

## Named oracles — a specialty *with a memory*

A named oracle = a skill + a persistent memory. It remembers the last time it looked at your code.

```bash
oracle oracle register --name senior-review --skill review --memory
oracle oracle register --name debugger --skill debug --model claude-sonnet-4-20250514
oracle oracle list

oracle consult --oracle senior-review -p "Review this"
```

With `--memory`, each consult tucks away a summary (`insight`) via [oracle-memory](https://github.com/JonusNattapong/oracle-memory), and past insights are injected into the next prompt. The oracle gets smarter about *your* project over time.

---

## Talking to the rest of the swarm

### 📮 Peer mesh (via oracle-messages)

Messages live in `.oracle/messages/`, the exact format [oracle-messages](https://github.com/JonusNattapong/oracle-messages) speaks.

```bash
oracle peer send --to claude --body "Review complete" --kind review-result
oracle peer list --agent oracle --limit 10
oracle peer monitor --agent oracle
oracle peer export senior-review -o oracle.json
oracle peer import oracle.json
```

### 🧠 Memory (via oracle-memory)

Entries live in `.oracle-memory/`, shared with the memory server.

```bash
oracle memory list
oracle memory list --agent senior-review
oracle memory clear
oracle memory clear senior-review
```

---

## Running as an MCP server

Prefer to drive Oracle from inside Claude Code or Codex? Serve it over MCP.

```bash
node dist/mcp.js                       # start the server

oracle setup-mcp --client claude-code  # generate client config
oracle setup-mcp --client codex
```

Tools exposed to the client:

| Tool | What it does |
|------|--------------|
| `oracle_consult` | Analyze project files with a skill |
| `oracle_skills` | List available skills |
| `oracle_oracle_list` | List registered oracle profiles |
| `oracle_oracle_register` | Create a named oracle |
| `oracle_memory_list` | List memory entries from `.oracle-memory` |
| `oracle_memory_clear` | Clear working memory |
| `oracle_sessions` | List recent sessions |
| `oracle_session_get` | Get session details |
| `oracle_doctor` | Check configuration and provider |

---

## Command cheat-sheet

```
oracle consult   -p <prompt> [--skill <name>] [--oracle <name>] [--diff [target]] [-f <pattern...>]
oracle doctor    [--provider <name>]
oracle oracle    list | register | unregister | show
oracle memory    list | clear
oracle skill     list | install <file.json>
oracle peer      export | import | send | list | monitor
oracle login     [--provider anthropic] [--client-id <id>]
oracle logout
oracle session   <id>
oracle status    [-n <limit>]
oracle setup-mcp [--client claude-code | codex]
```

---

## Configuration

Per-project settings in `.oracle/config.json`:

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

Where everything lives:

```
~/.oracle/
├── oracles/          # named oracle profiles
├── skills/           # custom skills
├── sessions/<id>/    # bundle.md · output.md · session.json
└── auth/             # OAuth tokens

<project>/
├── .oracle/config.json · skills/       # project-local config & skills
├── .oracle-memory/   facts · insights · chunks · working
└── .oracle/messages/ # the shared mailbox
```

Environment knobs:

| Variable | Default | Description |
|----------|---------|-------------|
| `ORACLE_HOME_DIR` | `~/.oracle` | Home for config, skills, oracles, sessions |
| `ORACLE_WORKSPACE_ROOT` | `cwd` | MCP workspace root |
| `OPENAI_API_KEY` | — | OpenAI provider |
| `ANTHROPIC_API_KEY` | — | Anthropic provider |
| `ANTHROPIC_CLIENT_ID` | — | Anthropic OAuth client ID |
| `ORACLE_MEMORY_ROOT_DIR` | `cwd` | Memory root (oracle-memory compatible) |

> **Windows note:** the memory sidecar ships as a Node script and the messages sidecar as a native binary. If you auto-manage them, point `ORACLE_MEMORY_BIN` / `ORACLE_MESSAGES_BIN` at the exact built files — Oracle knows how to launch each correctly.

---

## The rest of the family

- 🧠 [Oracle Memory](https://github.com/JonusNattapong/oracle-memory) — persistent memory layer
- 📮 [Oracle Messages](https://github.com/JonusNattapong/oracle-messages) — multi-agent message bus
- 📖 [Oracle Skill](https://github.com/JonusNattapong/oracle-skill) — the skill that teaches agents to use both

*One brain, one notebook, one group chat — no database in sight.*
