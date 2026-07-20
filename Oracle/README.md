# Oracle

<p align="center">
  <img src="docs/oracle-logo.png" alt="Oracle logo" width="720">
</p>

MCP-powered AI coding consultant with persistent memory, a docs knowledge
base, web access, and GitHub integration.
Ships both a CLI (`oracle`) and an MCP server (`oracle-mcp`) for Claude Code,
opencode, Clew Code, and any MCP-compatible agent.

## What it does

Oracle answers questions and reviews code with project context, and remembers
across conversations. It pulls context from four sources — persistent memory
(facts, insights, a compiled wiki), a local docs store (`.oracle/docs/`), the
web, and your project files — then asks a configured provider/model. It can
also read/review GitHub PRs and issues.

## Install & build

```bash
npm install
npm run build          # tsc -> dist/
node dist/cli.js doctor   # verify provider is wired up
```

Scripts: `build`, `dev` (tsx src/cli.ts), `mcp` (tsx src/mcp.ts),
`typecheck` (tsc --noEmit), `test` (vitest).

## CLI usage

```bash
oracle ask "what does ECONNRESET on a Redis client mean?"
oracle ask "review this for edge cases" -f "src/**/*.ts" --soul engineer
oracle consult -p "Review this" -f "src/**/*.ts" --diff HEAD~1
oracle doctor
```

Commands:

| Command | Purpose |
|---|---|
| `ask` | One-shot question; `-f` to include files, `--soul` for persona, `--conversation` for continuity |
| `consult` | Review with project context; `-f` globs, `--diff [target]`, `--github-pr owner/repo#n` |
| `watch` | Auto-review the working-tree diff on save |
| `memory` `list\|clear` | Inspect / clear the memory store |
| `wiki` `build\|list\|show` | Compile and browse the memory wiki |
| `docs` `list\|search\|add\|remove` | Manage the local docs knowledge base |
| `web` `search\|fetch\|extract` | Web search, fetch a URL, structured extract |
| `oracle` `list\|register\|unregister\|show` | Manage oracle profiles |
| `session` `list\|show` | Browse past consult sessions |
| `github` `check\|pr\|issue\|search\|get` | GitHub PR/issue access |
| `identity` `show\|setup`, `persona`, `skill`, `forget` | Identity, persona, skills, memory reset |
| `login` / `logout` | Anthropic OAuth |
| `doctor` | Check provider wiring |
| `setup-mcp` | Generate MCP client config |

## MCP server

Wire `oracle-mcp` (built to `dist/mcp.js`) into your MCP client:

```json
{
  "mcpServers": {
    "oracle": {
      "command": "node",
      "args": ["/absolute/path/to/Oracle/dist/mcp.js"],
      "env": {
        "ORACLE_USE_OLLAMA": "1",
        "ORACLE_WORKSPACE_ROOT": "/absolute/path/to/your/project"
      }
    }
  }
}
```

Or run `oracle setup-mcp` to generate it.

## MCP tools (46)

**Ask / consult**
`oracle_ask`, `oracle_consult`

**Memory**
`oracle_memory_list`, `oracle_memory_search`, `oracle_memory_update`,
`oracle_memory_stats`, `oracle_memory_clear`

**Memory wiki**
`oracle_memory_wiki_build`, `oracle_memory_wiki_list`, `oracle_memory_wiki_get`

**Docs**
`oracle_docs_list`, `oracle_docs_search`, `oracle_docs_add`, `oracle_docs_remove`

**Web**
`oracle_web_search`, `oracle_web_fetch`, `oracle_web_extract`

**GitHub**
`oracle_github_pr_list`, `oracle_github_pr_get`, `oracle_github_pr_diff`,
`oracle_github_pr_files`, `oracle_github_pr_review`,
`oracle_github_pr_review_submit`, `oracle_github_issue_get`,
`oracle_github_issue_list`, `oracle_github_comment`, `oracle_github_search`,
`oracle_github_api`

**Oracle profiles**
`oracle_oracle_list`, `oracle_oracle_register`

**Identity / persona**
`oracle_identity_show`, `oracle_identity_setup`, `oracle_persona_set`

**Sessions / skills / health**
`oracle_sessions`, `oracle_session_get`, `oracle_skills`, `oracle_doctor`

## Configuration

Project config lives in `.oracle/config.json`:

```json
{
  "provider": "codex",
  "model": "gpt-5.4-mini",
  "include": ["src/**/*", "README.md", "package.json"],
  "exclude": ["**/*.test.ts", "**/node_modules/**", "**/dist/**"],
  "maxFileSizeBytes": 1000000,
  "maxInputBytes": 5000000
}
```

Environment variables:

| Var | Purpose |
|---|---|
| `ORACLE_WORKSPACE_ROOT` | Project root the MCP server operates on |
| `ORACLE_HOME_DIR` | Override the `~/.oracle` home (sessions, profiles, config) |
| `ORACLE_USE_OLLAMA` | Enable semantic memory search via Ollama embeddings |
| `OLLAMA_HOST` | Ollama endpoint (default `http://127.0.0.1:11434`) |
| `OLLAMA_EMBED_MODEL` | Embedding model (default `nomic-embed-text`) |

Provider API keys are read from the environment / `.env` (see `oracle doctor`).
