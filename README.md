# Oracle

> A senior engineer you can summon with one command. It reads your code, thinks with a real model, remembers what it learned, and can talk to other agents while it works.

**Oracle** is an MCP-powered AI coding consultant. Point it at some files,
ask a question, and it bundles the right context, sends it to the model of
your choice, and hands back a real review — not a vibe.

```
you ──▶ oracle consult ──▶ bundle context ──▶ think (AI) ──▶ answer
               │                                              │
         skills · oracles                              saved as session
               │                                              │
     memory (oracle-memory)  ◀───────────────────▶  mesh (oracle-messages)
```

## Quick start

```bash
npm install && npm run build
node dist/cli.js doctor          # check provider is wired up
node dist/cli.js consult -p "Review this" -f "src/**/*.ts"
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

## Web search & fetch

Requires `BRAVE_API_KEY` (free tier at https://brave.com/search/api/):

```bash
oracle web search "redis connection pool exhausted" -n 5
oracle web fetch https://redis.io/docs/latest/develop/connect/clients/pool/
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

## Tools (37 MCP tools)

Run as MCP server:

```bash
node dist/mcp.js                 # stdio MCP server
```

### Core

| Tool | What it does |
|------|--------------|
| `oracle_consult` | Analyze code with a skill |
| `oracle_ask` | Ask Oracle anything — uses soul prompts (`~/.oracle/souls/`) |
| `oracle_skills` | List available skills |

### Memory — `.oracle-memory/`

| Tool | What it does |
|------|--------------|
| `oracle_memory_list` | List memories by type/agent |
| `oracle_memory_search` | Keyword or semantic search (Ollama) |
| `oracle_memory_update` | Edit content/tags of existing memory |
| `oracle_memory_stats` | Count by type and agent |
| `oracle_memory_clear` | Clear working memory |

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
| `oracle_web_search` | Search the web (Brave Search API — needs `BRAVE_API_KEY`) |
| `oracle_web_fetch` | Fetch a URL, return readable text (HTML stripped) |

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
