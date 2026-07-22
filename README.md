# Oracle

> **Oracle is a persistent coordination layer for AI coding agents — not a database, not a replacement for your agent, but a shared teammate that remembers everything and keeps everyone on the same page.**

When you fire up Claude Code, it has no memory of yesterday's work. If you start two Claude sessions, they can't talk to each other. If you want the agent to actually *do* something (not just talk about doing it), you have to manually approve every file change and run every command.

**Oracle fixes this.** It is an MCP server that any agent wires into (Claude Code, opencode, Codex, Gemini CLI, …) to gain:

- **Persistent memory** — everything the agent learns is saved and ranked by relevance; future sessions find it instantly
- **Consultation engine** — ask a question with full project context (code + memory + docs + web) and get a grounded answer with citations
- **Autonomous action** — an agent sandbox that can read/write files and run commands, confined to your workspace, fully audited
- **Inter-agent coordination** — multiple agent sessions on one machine can message each other, hand off work, wake each other up when something needs attention
- **Task planning & verification** — a lead breaks work into assigned tasks with checklists; agents can't report "done" until their declared verification steps are actually checked off, and the lead is auto-notified when work is ready to review
- **ASCII work board** — a lead can render the live agent roster and its main TODOs in any MCP client with `oracle_task_board`

**Requires Node.js ≥ 24.** Installs three binaries: `oracle` (CLI), `oracle-mcp` (full MCP server), `oracle-msg-mcp` (messaging + task-tracking server for agents that only need to coordinate, not consult or act).

---

## What Problem Does Oracle Solve?

### Without Oracle

```
Session 1: Claude Code
  └─ Learns that Service X uses connection pool Y
  └─ Closes session
     └─ All context is gone forever

Session 2: Different Claude Code session
  └─ Asks the same question again
  └─ No way to know what Session 1 learned

Session A: Claude Code session (refactoring)
Session B: Claude Code session (bug fix)
  └─ They're isolated; A has to DM you to tell B what changed
  └─ You act as the messenger
```

### With Oracle

```
Session 1: Claude Code → Oracle
  └─ Learns fact X → stored in memory
  └─ Closes session
     └─ Fact X stays in the shared store

Session 2: Claude Code → Oracle
  └─ Asks a question
  └─ Oracle recalls Fact X automatically (ranked by relevance)
  └─ Answer is grounded in what Session 1 learned

Session A: Claude Code → Oracle
  └─ Sends: "Refactoring done, 3 files changed"

Session B: Claude Code → Oracle
  └─ Receives message from A instantly
  └─ Can ask Oracle to fetch the list of changed files
  └─ Coordinates autonomously; no human in the loop
```

---

## The Five Pillars

| Pillar | What It Does | How To Use |
|--------|--------------|-----------|
| 🧠 **Remember** | Persistent memory across sessions — facts auto-ranked by recency, access frequency, semantic match, and importance. Entity graph to find related knowledge. Auto-consolidation to kill duplicates. | MCP: `oracle_memory_*` tools. CLI: `oracle memory list/search/update/consolidate`. Agent sees memory auto-injected into context. |
| 💬 **Consult** | Ask a question with your real project context (code files + memory + docs + web search/fetch). Get a cited answer back. | MCP: `oracle_ask`. CLI: `oracle ask "question" -f "src/**/*.ts"`. Agent can search memory, read files, fetch URLs, then answer. |
| 🛠️ **Act** | Autonomous agent that reads/writes/edits files to complete a task. **Sandbox: no shell execution, filesystem-only.** Full audit trail of every mutation (who, when, what changed, hash). | MCP: `oracle_agent`. CLI: `oracle agent "write a test for X"`. Agent loops until done; logs all file changes. |
| 📨 **Coordinate** | Inter-agent message bus on one machine. Agents send/receive messages, reply in threads, mark as read. Broadcasts. Presence roster (who's active). One-call onboarding (register → see who else is there + your unread work). | MCP: `oracle_msg_*`. CLI: `oracle msg send/inbox/ack/watch`. Auto-injected instructions tell every agent to register before starting work. Presence is automatic (every action updates lastSeen). |
| ✅ **Verify** | Task tracker on top of the message bus: create + assign work with a checklist, log progress notes, and submit for review — which **blocks** if any checklist item is unchecked and auto-reports to the task creator. Reviewer approves (done) or rejects with a note (bounces back). | MCP: `oracle_task_*`. CLI: `oracle task create/update/check/submit/close/list`. |

---

## Quick Start

### Install

```bash
# From npm
npm install -g @oraclepersonal/oracle
oracle doctor                # verify a provider is set up

# From source (development)
git clone https://github.com/OraclePersonal/Oracle.git
cd Oracle
npm install && npm run build
node dist/cli.js doctor
```

### Wire up an MCP client

**Claude Code:**
```bash
oracle setup-mcp --client claude-code
```

This generates `.claude/mcp.json` with the config. Restart Claude Code; you'll see `oracle_*` tools appear.

**opencode or any MCP client:**
```json
{
  "mcpServers": {
    "oracle": {
      "command": "npx",
      "args": ["-p", "@oraclepersonal/oracle", "oracle-mcp"],
      "env": {
        "ORACLE_WORKSPACE_ROOT": "/path/to/your/project"
      }
    }
  }
}
```

### Set a model provider

```bash
export ANTHROPIC_API_KEY=sk-...    # or OPENAI_API_KEY, etc.
oracle doctor                       # verify it works
```

Supported: `anthropic`, `openai`, `opencode`, `codex`

---

## Core Features

### 1. Persistent Memory (ML-Ranked Retrieval)

Every `oracle_memory_*` call updates the knowledge graph. Future queries auto-rank by:
- **Recency** — accessed/updated recently? Rank higher.
- **Frequency** — used often? Rank higher.
- **Semantic match** — similar to the query? Rank higher.
- **Importance** — manually set, or promoted automatically if used frequently.
- **Entity graph** — "Service X" links to "connection pool Y"; expanding queries finds both.

Auto-consolidation: finds overlapping memories by tag similarity (Jaccard ≥ 0.3) and merges them.

To keep memory fast and inexpensive, Oracle normalizes tags, rejects exact duplicate content before writing, and uses local token-overlap ranking when embeddings are unavailable. These paths make no model or embedding request.

Background maintenance runs every 1 hour (tunable): consolidate, prune stale low-value memories, promote frequently-used working memories to durable insights.

**Memory scopes:** project memory is stored at `<workspace>/.oracle-memory/` and stays isolated to that work. Shared, cross-project memory is stored at `~/.oracle/memory/`. Memory MCP tools use `scope: "project"` by default; pass `scope: "global"` only for durable cross-project knowledge such as team conventions or agent roles.

### 2. Consultation Engine

`oracle ask` (or `oracle_ask` MCP tool) is a one-shot Q&A. You ask a question, and Oracle:
1. Reads your **tone** from the question (auto-picks a personality: engineer, socratic, playful, etc.)
2. Includes relevant **memory** (semantic search + entity graph)
3. Searches your **docs** (if configured)
4. Runs **web search/fetch** (if enabled)
5. Reads **code files** (if specified via `-f` glob)
6. Fetches **GitHub PR/issue context** (if linked)
7. Passes all of that to a model provider → gets a grounded answer with citations

**CLI:**
```bash
oracle ask "why is this service timing out?"
oracle ask "review this code" -f "src/handlers/**/*.ts"
oracle ask "what's in our latest PR?" --include-gh
```

**MCP:** `oracle_ask { question, files?, soul?, ... }`

### 3. Autonomous Agent (Sandbox + Audit Trail)

`oracle agent` is an **agentic loop** that reads/writes files to complete a task. It:
- **Has no shell.** The agent can read/write files, edit code, but cannot run bash commands directly. (This is a security boundary, not a limitation — the agent learns its workspace constraints and works within them.)
- **Is fully audited.** Every file write is logged with: timestamp, agent name, SHA256 hash of new content, diff summary. Mutations can be replayed or reverted.
- **Runs until done.** The agent loops, learns from test failures or edge cases, and keeps editing until it declares success.

**CLI:**
```bash
oracle agent "add error handling to src/handler.ts, test it, commit"
```

**MCP:** `oracle_agent { task, soul?, ... }`

### 4. Inter-Agent Coordination (Message Bus)

**The problem Oracle solves:** Two Claude Code sessions run in parallel. One finishes a refactor. How does the other know? How do they coordinate without you being the messenger?

**Solution: Shared message bus at `~/.oracle/messages/`**

Every agent can:
- **Register** (`oracle_msg_register`) — one call: register name/role → get the roster + your unread messages. Presence updates automatically.
- **Send** (`oracle_msg_send`) — to one agent, or broadcast (`to: "*"`) to all.
- **Receive** (`oracle_msg_inbox`) — see messages for you; filter by read/unread; limit results.
- **Reply** in **threads** (`replyTo`) — keeps conversation organized.
- **Ack** (`oracle_msg_ack`) — mark handled so Stop hook doesn't re-trigger.

**Key:** MCP server sends **instructions** to every client on connect:
> *"Before starting work: (1) register with oracle_msg_register (name + role). (2) Check your unread messages. (3) Handle anything urgent. Then proceed."*

No human has to say "go check your messages." The agent learns the pattern from instructions alone.

**Wake-up mechanics (3 tiers):**
1. **Pull** — Agent calls `oracle_msg_inbox` when it feels like it.
2. **Push-on-idle (Stop hook)** — When Claude finishes a turn and tries to stop, the hook checks for unread messages. If any, it blocks the stop → Claude reads/acks → then can close.
3. **Real-time push (watcher)** — `oracle msg watch -a <agent> --exec "<cmd>"` — a separate process watches the bus and fires a command (e.g. `tmux send-keys`) the moment a message lands.

**CLI:**
```bash
oracle msg send -f lead -t worker -b "review this" --body-file findings.txt
oracle msg inbox -a worker --json --wait --timeout 120
oracle msg ack -a worker <id>
oracle msg watch -a codex --exec 'notify-send "Message from $ORACLE_MSG_FROM"'
```

**Storage:** `~/.oracle/messages/` (atomic JSON) + `~/.oracle/agents/` (presence registry).

### 5. Task Planning, Tracking & Verification (built on the message bus)

**The problem:** messaging alone doesn't give you accountability. Nothing
stops an agent from claiming "done" without actually finishing, and nothing
tracks who's responsible for what or what happened along the way.

**Solution: a task tracker layered on top of the bus**, with a lifecycle —
`pending → in_progress → review → done` (or `blocked`/`cancelled`) — and a
hard verification gate:

- **Create & assign** (`oracle_task_create`) — a lead breaks work into tasks,
  each with an assignee and an optional checklist of concrete verification
  steps. Auto-messages the assignee.
- **Track progress** (`oracle_task_update`) — the assignee logs status
  changes and notes as they work; this is the audit trail, not just an
  end-of-task summary.
- **Verify before reporting** (`oracle_task_checklist` + `oracle_task_submit`)
  — the assignee checks off each item as it's genuinely done. Submitting for
  review **fails** if anything is still unchecked — an agent cannot report
  done prematurely.
- **Report to the lead automatically** — a successful submit messages the
  task's creator with the summary; no separate "I'm done" message needed.
- **Close it out** (`oracle_task_close`) — the reviewer approves (→ `done`,
  assignee notified) or rejects with a note (→ back to `in_progress`,
  assignee notified with what's missing).

**CLI:**
```bash
oracle task create --title "Add rate limiting" --created-by lead --assignee builder \
  --checklist "implement limiter" "add tests" "update docs"
oracle task update <id> -a builder --status in_progress --note "starting"
oracle task check <id> 0        # check off item 0 as done
oracle task submit <id> -a builder --summary "limiter implemented, tested, documented"
oracle task close <id> -a lead                        # approve
oracle task close <id> -a lead --reject --note "..."  # send back
oracle task list --assignee builder --active
```

**Storage:** `~/.oracle/tasks/` (atomic JSON, one file per task).

#### ASCII work board

Agent names are free-form identifiers, so a team can register names such as
`claude-lead`, `codex-content-1`, `codex-marketing-2`, and `opencode-worker-1`.
The Lead creates the main TODOs with `oracle_task_create`; then any client can
show the workstream in a terminal-safe board:

```
oracle_task_board { createdBy: "claude-lead", activeOnly: true }
```

It renders the registered agent roles/activity and the Lead's active TODOs,
grouped by status and assignee. The existing `parentId` field can link smaller
assigned tasks to a larger Lead-created TODO.

---

## MCP Tools (60 Total)

### Memory (18 tools)
`oracle_memory_*` — remember, search, scored_search, list, update, clear, consolidate,
prune, promote, reflect, stats, maintenance, wiki_build/get/list, graph
query/path/prune/stats.

### Consultation & Agent (5 tools)
`oracle_ask`, `oracle_agent`, `oracle_sessions`, `oracle_session_get`, `oracle_doctor`

### Messaging & Coordination (6 tools)
`oracle_msg_register`, `oracle_msg_agents`, `oracle_msg_send`, `oracle_msg_inbox`, `oracle_msg_ack`, `oracle_msg_thread`

### Task Planning & Tracking (8 tools)
`oracle_task_create`, `oracle_task_board`, `oracle_task_list`, `oracle_task_get`, `oracle_task_update`,
`oracle_task_checklist`, `oracle_task_submit`, `oracle_task_close`

### Identity & Config (3 tools)
`oracle_identity_setup`, `oracle_identity_show`, `oracle_persona_set`

### GitHub Integration (11 tools)
PR/issue listing & get, diff viewing, file listing, review + review-submit,
comments, search, API passthrough.

### Docs & Web (7 tools)
Doc indexing (add/list/remove/search), web search, web fetch, structured web extraction.

### Oracle Profiles & Skills (3 tools)
`oracle_oracle_list`, `oracle_oracle_register`, `oracle_skills`

See [**MESSAGING.md**](MESSAGING.md) for the full messaging + task-tracking
reference; [**docs/**](docs/) for deeper architecture.

---

## Configuration

### Environment Variables

```bash
ORACLE_WORKSPACE_ROOT      # Project root (default: cwd)
ORACLE_HOME_DIR            # Memory/agents/messages store (default: ~/.oracle)
ORACLE_MEMORY_LLM_GRAPH    # Enable LLM-based memory graph reflection (default: off)
ANTHROPIC_API_KEY          # For Claude models (required if using Anthropic)
OPENAI_API_KEY             # For GPT (required if using OpenAI)
```

### Setup Steps

1. **Install:** `npm install -g @oraclepersonal/oracle`
2. **Provider:** Export `ANTHROPIC_API_KEY` (or your provider).
3. **Workspace:** `cd /path/to/project`
4. **MCP:** `oracle setup-mcp --client claude-code` (or wire manually).
5. **Identity:** `oracle identity setup` (optional; sets your name/preferences).
6. **Test:** `oracle doctor`

---

## Architecture

```
Oracle MCP Server (src/mcp/)
├─ Consultation Engine (src/core/consult.ts)
│  └─ Reads workspace, memory, docs, web; asks a model
├─ Memory System (src/memory/)
│  └─ BM25 + vector search + entity graph + auto-consolidation
├─ Messaging Bus (src/messaging/)
│  └─ File-backed store + registry + watcher + CLI + onboarding hooks
├─ Task Tracker (src/tasks/)
│  └─ File-backed store: plan/assign/verify/report, layered on messaging
├─ Agent Sandbox (src/agent/)
│  └─ File R/W, audit trail, no shell, looping until done
├─ Observability (src/observability/)
│  └─ Structured JSON logging to stderr
├─ Identity & Personas (src/identity/)
│  └─ Profile store + auto mood detection
└─ Skills & Oracles (src/skills/, src/oracles/)
   └─ Reusable skill registry + custom oracle profiles

CLI (src/cli.ts)
├─ oracle ask, agent, memory, msg, task, identity, ...
├─ same bus as MCP (shared ~/.oracle/)
└─ designed for scripting & local use

Standalone Coordination Server (src/mcp-messaging.ts)
├─ The 6 oracle_msg_* + 8 oracle_task_* tools
├─ No provider/memory/agent stack
└─ for agents that only need to coordinate, not consult or act
```

**Storage Layout:**
```
~/.oracle/
├─ messages/              # Inter-agent message store (atomic JSON per message)
├─ tasks/                 # Task tracker (atomic JSON per task, one file each)
├─ agents/                # Presence registry (one JSON per registered agent)
├─ memory/                # Persistent memory (facts, insights, wiki, graph)
├─ skills/                # Local skill definitions
└─ .sessions/             # Session cache
```

---

## Security Model

### Agent Sandbox (No Shell)

The agent has **no access to bash/shell.** It can only:
- Read files (via `Read` tool)
- Write files (via `Write` / `Edit` tools)
- Spawn other agents via MCP

It **cannot:**
- Run arbitrary commands
- Install packages
- Fork processes
- Escape the workspace

**Why?** Shell access = footgun risk. Agents are deterministic; if they need to run something, you either (1) provide a tool for it, or (2) ask for explicit permission.

### Audit Trail

Every file mutation (write/edit/delete) is logged:
```json
{
  "timestamp": "2026-07-22T15:30:45.123Z",
  "agent": "claude-code",
  "file": "src/handler.ts",
  "action": "edit",
  "hash": "sha256:abc123...",
  "diff": "..."
}
```

Audits are immutable; they go to `~/.oracle/audits/` and can be replayed or reviewed.

### Message Bus Security

Messages are not encrypted (they're in a local JSON store), so **this is only suitable for single-machine multi-agent coordination,** not cross-network. If you need to send messages over the network, TLS should wrap the MCP server.

---

## Limitations & Known Issues

- **Memory store grows unbounded.** Prune old memories by hand or via `oracle memory prune`.
- **Concurrent writes to the same message can lose one ack.** Read-modify-write without a lock. If two agents ack the same broadcast simultaneously, one ack might not be recorded. Workaround: re-ack.
- **Windows rename under contention.** On heavy concurrent load, `fs.rename()` can fail EPERM. Retry succeeds.
- **Stop hook is fragile.** If a hook dies or times out, Claude closes anyway. Make hooks fast (< 1 second).

---

## Testing

```bash
npm run test              # vitest run src
npm run typecheck        # tsc --noEmit
npm run build            # tsc -> dist/
```

232 tests cover messaging, memory, agent sandbox, and MCP integration.

---

## Contributing

This is a **single monorepo** (moved from multi-repo on 2026-07-18). Fork, branch, and open PRs against `main`. Each commit must:
- Pass `npm run typecheck && npm run test`
- Follow file mutation audit conventions
- Reference related docs or issues

**Development loop:**
```bash
npm install
npm run dev              # tsx src/cli.ts (hot reload)
npm run mcp             # tsx src/mcp.ts
npm run mcp:messaging   # tsx src/mcp-messaging.ts
npm run test            # watch mode: vitest
```

---

## Learn More

- [**Messaging Flow & Setup**](MESSAGING.md) — How agents coordinate, wake-up tiers, CLI reference, troubleshooting.
- [**Skill System**](.claude/skills/oracle-messaging/SKILL.md) — Portable SKILL.md that teaches any agent how to use the bus.
- [**Architecture Deep-Dive**](docs/architecture.md) — System design, data flow, threat model.
- [**Agent & Autonomy**](docs/AGENT.md) — How the sandbox works, audit trail, limitations.

---

## License

MIT. Not affiliated with Oracle Corp or the Oracle database.

**Why is it called Oracle?** An oracle is something you *consult* — it remembers, knows, and answers. This project is that for your agents: a shared source of truth they return to, and a switchboard they use to reach each other.
