# Oracle

> A personal AI assistant you keep around, not a one-shot tool you invoke. Ask it anything, it remembers across every conversation, and it can act on your behalf — reviewing code is one of the things it does, not the point of it.

**Oracle** is an MCP-powered assistant with persistent memory, a knowledge
base, web access, and its own coordination layer for working alongside other
agents (Claude, opencode, etc.) instead of just answering when asked.

```
you ──▶ oracle ask ──▶ context (memory · docs · web · files) ──▶ think (AI) ──▶ answer
              │                                                                  │
     conversation continuity                                          remembers what it said
              │                                                                  │
     memory (facts · insights · wiki)  ◀───────────────────▶  mesh (locks · messages to other agents)
```

## Quick start

```bash
npm install && npm run build
node dist/cli.js doctor          # check provider is wired up
node dist/cli.js consult -p "Review this" -f "src/**/*.ts"
```

## Just talk to it: `oracle ask`

One entry point for both "just answer me" and "look at this code" — pass
`-f` when the question needs real files, skip it for a plain conversation.
Pass `--conversation <id>` across multiple calls in the same exchange and
Oracle recalls what it already told you (a token-budgeted rolling window,
not an unbounded transcript — see [Self-memory](#self-memory--conversation-continuity) below):

```bash
oracle ask "what does this error mean: ECONNRESET on a Redis client?"
oracle ask "review this for edge cases" -f "src/**/*.ts" --soul engineer
oracle ask "does that still hold if it's a cluster?" --conversation redis-debug-1
```

## Self-memory & conversation continuity

`oracle ask --conversation <id>` writes a compact log of each question+answer
under that id (`.oracle-memory/`, `working` type, auto-clears — it's not a
durable fact). The *next* call with the same id gets that history back as
context, capped by token budget (not just a fixed number of turns): the
newest turns are kept until the budget runs out, and the block says how
many earlier turns were left out rather than silently growing the prompt
forever or silently dropping history with no trace.

## Autonomy: `oracle watch`

Everything else in Oracle is reactive — you ask, it answers. `watch` is the
one proactive path: it watches the working tree, and on a quiet period
after a change, runs `git diff` and reviews it on its own, no prompt needed.

```bash
oracle watch                                  # review to stdout on every quiet-period change
oracle watch --to claude --skill review       # also push the result via oracle-messages
oracle watch --debounce 5000 --provider anthropic
```

## The one command: `consult`

```bash
oracle consult -p "Review for edge cases" -f "src/**/*.ts"
oracle consult -p "Find bugs" --skill debug
oracle consult --oracle senior-review -p "Review this PR"
oracle consult -p "Review my changes" --diff
oracle consult -p "Follow-up" --previous-session-id <id>
```

## Skills

Five built-in: `review`, `debug`, `architecture`, `tests`, `security`.

```bash
oracle skill list
oracle skill install ./my-skill.json
```

## Named oracles

A skill + a persistent memory:

```bash
oracle oracle register --name senior-review --skill review --memory
oracle consult --oracle senior-review -p "Review this"
```

## Peers

```bash
oracle peer send --to claude --body "Review complete" --kind review-result
oracle peer list --agent oracle --limit 10
```

### Multi-agent locks

When more than one agent (Claude, opencode, Oracle itself) might touch the
same file at once, claim it first — a lock is a plain exclusive file create,
so two agents racing for the same resource can't both win, and an abandoned
lock (crashed agent) expires and can be stolen after its TTL:

```bash
oracle peer lock "src/auth.ts" --agent claude
oracle peer lock-status "src/auth.ts"
oracle peer unlock "src/auth.ts" --agent claude
```

## Memory wiki

`oracle wiki build` compiles every fact/insight into topic-grouped Markdown
pages under `.oracle/wiki/<topic>.md` (grouped by tag) — a readable view over
memory, including anything superseded, not a second store to keep in sync:

```bash
oracle wiki build
oracle wiki list
oracle wiki show redis
```

## Web search, fetch & extract

Four pluggable providers, each doing a different job:

| Provider | Job | Env var |
|----------|-----|---------|
| Brave | Web search (free tier: 2000 queries/mo) | `BRAVE_API_KEY` |
| Tavily | Web search tuned for LLM consumption | `TAVILY_API_KEY` |
| Firecrawl | Web search, or JS-rendered scrape → markdown | `FIRECRAWL_API_KEY` |
| AgentQL (TinyFish) | Structured field extraction from a URL | `AGENTQL_API_KEY` |

`oracle web search` picks the first configured provider (Brave → Tavily →
Firecrawl) unless `--provider` is given — and on failure falls through to the
*next* configured provider (a real fallback chain, not just "give up").
`oracle web fetch` defaults to Oracle's own SSRF-guarded HTML-to-text fetch
(`native`); pass `--provider firecrawl` for pages that need real JS rendering.

Every search/fetch/extract call logs one JSON line to stderr (`[oracle:web]
{...}`) with provider, why it was chosen, outcome, and latency — set
`ORACLE_WEB_LOG=0` to silence it. `oracle web search --trace` prints the same
routing/fallback chain to the terminal. `oracle_web_extract` results carry
`sourceUrl` alongside the extracted data so a downstream fact can always be
traced back to where it came from, and reject outright if the page yielded
nothing extractable rather than returning an empty result as if it were valid.

```bash
oracle web search "redis connection pool exhausted" -n 5
oracle web search "redis connection pool exhausted" --provider tavily
oracle web search "redis connection pool exhausted" --trace
oracle web fetch https://redis.io/docs/latest/develop/connect/clients/pool/
oracle web fetch https://spa-docs.example.com/ --provider firecrawl
oracle web extract https://shop.example.com/item/42 "the product name and price"
```

## Knowledge base — `.oracle/docs/`

Drop project documentation (`.md`, `.txt`, `.json`, `.mdx`) into `.oracle/docs/`
and Oracle indexes it for retrieval: each file is chunked by markdown heading
(hard-wrapped past ~1200 chars for long sections) and ranked with BM25 — not
whole-file keyword matching. The chunk index is cached in
`.oracle/docs/.index.json` and only rebuilds for files whose mtime/size changed.

```bash
oracle docs list
oracle docs search "redis timeout" -n 5
oracle docs add auth/oauth.md -f ./notes.md
oracle docs remove auth/oauth.md
```

`oracle_ask` can pull matching passages in automatically via `include_docs: true`.

## Tools (44 MCP tools)

Run as MCP server:

```bash
node dist/mcp.js                 # stdio MCP server
```

### Core

| Tool | What it does |
|------|--------------|
| `oracle_consult` | Analyze code with a skill |
| `oracle_ask` | Ask anything, optionally with `files` to include and `conversationId` for multi-turn continuity |
| `oracle_skills` | List available skills |

### Memory — `.oracle-memory/`

| Tool | What it does |
|------|--------------|
| `oracle_memory_list` | List memories by type/agent |
| `oracle_memory_search` | Keyword or semantic search (Ollama) |
| `oracle_memory_update` | Edit content/tags of existing memory |
| `oracle_memory_stats` | Count by type and agent |
| `oracle_memory_clear` | Clear working memory |
| `oracle_memory_wiki_build` / `oracle_memory_wiki_list` / `oracle_memory_wiki_get` | Compile & read the topic-grouped memory wiki |

### Knowledge base — `.oracle/docs/`

| Tool | What it does |
|------|--------------|
| `oracle_docs_list` | List indexed doc files |
| `oracle_docs_search` | BM25-ranked passage search |
| `oracle_docs_add` | Add/overwrite a doc file |
| `oracle_docs_remove` | Delete a doc file |

Semantic search via Ollama (opt-in):

```bash
ORACLE_USE_OLLAMA=1 node dist/mcp.js
```

Uses `nomic-embed-text` for vectors. Falls back to keyword search if Ollama is unavailable.

### Soul Prompts — `~/.oracle/souls/`

Soul prompts define Oracle's personality when asked via `oracle_ask`:

| Soul | When to use |
|------|-------------|
| `default` | Principal engineer — direct, no fluff |
| `engineer` | Senior dev — answers with code |
| (add your own) | Drop a `.md` file into `~/.oracle/souls/` |

### Agent-to-Agent

| Tool | What it does |
|------|--------------|
| `oracle_peer_send` / `oracle_peer_broadcast` | Send messages via oracle-messages |
| `oracle_peer_list` / `oracle_peer_unread` / `oracle_peer_thread` | Read messages |
| `oracle_peer_lock_acquire` / `oracle_peer_lock_release` / `oracle_peer_lock_check` | Multi-agent file/resource locks |
| `oracle_oracle_list` / `oracle_oracle_register` | Named oracle profiles |

### Identity

| Tool | What it does |
|------|--------------|
| `oracle_identity_show` / `oracle_identity_setup` | Your profile |
| `oracle_persona_set` | Oracle's voice and tone |

### GitHub

| Tool | What it does |
|------|--------------|
| `oracle_github_pr_get` / `oracle_github_pr_list` | PR details |
| `oracle_github_pr_diff` / `oracle_github_pr_files` | PR diff/files |
| `oracle_github_pr_review` | AI review (doesn't post) |
| `oracle_github_pr_review_submit` | Post APPROVE/CHANGES/COMMENT |
| `oracle_github_issue_get` / `oracle_github_issue_list` | Issues |
| `oracle_github_comment` / `oracle_github_search` / `oracle_github_api` | Misc |

### Web

| Tool | What it does |
|------|--------------|
| `oracle_web_search` | Search via Brave/Tavily/Firecrawl (auto-picks a configured provider) |
| `oracle_web_fetch` | Fetch a URL — `native` (SSRF-guarded) or `firecrawl` (JS rendering) |
| `oracle_web_extract` | Extract structured fields from a URL (AgentQL/TinyFish) |

### System

| Tool | What it does |
|------|--------------|
| `oracle_doctor` | Check provider + config health |
| `oracle_sessions` / `oracle_session_get` | Consult history |

## Soul prompt system

When another agent is stuck, it calls `oracle_ask` with a `soul` name:

```json
{
  "question": "Redis timeout after 5s on high load",
  "soul": "engineer",
  "context": "Error: Redis connection timeout (pool exhausted)"
}
```

Oracle loads `~/.oracle/souls/<name>.md` as its system prompt and answers.
No soul file? Falls back to: *"You are Oracle, a senior engineer. Answer concisely."*

### Layout

```
~/.oracle/
├── oracles/           # named profiles
├── skills/            # custom skills
├── souls/             # soul prompts (default.md, engineer.md, ...)
├── sessions/<id>/     # consult history
└── auth/              # provider tokens

<project>/
├── .oracle/config.json
├── .oracle-memory/    # facts · insights · chunks · working
└── .oracle/messages/  # shared mailbox
```

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | Compile TypeScript |
| `npm run check` | Type-check only |
| `npm run dev` | Run CLI via tsx |
| `npm run mcp` | Run MCP server via tsx |
| `npm start` | Run compiled |
| `npm test` | Run tests |

## Related

- [Oracle-memory](https://github.com/OraclePersonal/Oracle-memory) — File-backed MCP memory server
- [Oracle-messages](https://github.com/OraclePersonal/Oracle-messages) — Multi-agent MCP message bus
- [Oracle-skill](https://github.com/OraclePersonal/Oracle-skill) — Cross-agent workflow docs
- [Oracle-templates](https://github.com/OraclePersonal/Oracle-templates) — Template system
- [Oracle-dashboard](https://github.com/OraclePersonal/Oracle-dashboard) — Live web dashboard
- [Oracle-eval](https://github.com/OraclePersonal/Oracle-eval) — Benchmark suite
