# Oracle

<p align="center">
  <img src="docs/oracle-logo.png" alt="Oracle logo" width="720">
</p>

MCP-powered AI coding consultant with persistent memory, a docs knowledge
base, web access, and GitHub integration.
Ships both a CLI (`oracle`) and an MCP server (`oracle-mcp`) for Claude Code,
opencode, Clew Code, and any MCP-compatible agent.

Requires **Node.js ≥ 24**.

## What it does

Oracle answers questions and reviews code with project context, and remembers
across conversations. It pulls context from four sources — persistent memory
(facts, insights, a compiled wiki), a local docs store (`.oracle/docs/`), the
web, and your project files — then asks a configured provider/model. It can
also read/review GitHub PRs and issues.

**Autonomous agent mode** (`oracle_agent`): Run agentic tasks autonomously with
file system access, shell execution, and **multimodal input** (images, videos).
Apply engineering skills (review, debug, security, architecture, tests) to guide
agent reasoning. Discover and invoke tools from external MCP servers.

**Supported providers:** `codex`, `openai`, `anthropic`, `opencode`

## Install & build

```bash
npm install
npm run build              # tsc -> dist/
node dist/cli.js doctor    # verify provider is wired up
```

Scripts: `build`, `dev` (tsx src/cli.ts), `mcp` (tsx src/mcp.ts),
`typecheck` (tsc --noEmit), `test` (vitest run src).

## CLI usage

```bash
# One-shot questions — Oracle reads your mood and adapts automatically
oracle ask "what does ECONNRESET on a Redis client mean?"
oracle ask "review this for edge cases" -f "src/**/*.ts"
oracle ask "summarise this module" --include-docs

# Or pick a specific personality with --soul
oracle ask "review this code" --soul engineer

oracle doctor
```

> **Auto mood** — When you don't pass `--soul`, Oracle reads your tone from the question
> and freely picks its own personality: playful, serious, sarcastic, gentle, dramatic,
> or whatever fits the moment. It can even shift mid-conversation.

Commands:

| Command | Purpose |
|---|---|
| `ask` | One-shot question; `-f` to include files, `--soul` for specific personality, `--conversation` for continuity, `--include-docs` for local docs. **No `--soul` = Oracle chooses its own mood automatically** |
| `memory` `list\|clear` | Inspect / clear the memory store |
| `wiki` `build\|list\|show` | Compile and browse the memory wiki |
| `docs` `list\|search\|add\|remove` | Manage the local docs knowledge base |
| `web` `search\|fetch\|extract` | Web search (`--provider`, `--trace`), fetch a URL (`--provider`), structured extract (AgentQL) |
| `oracle` `list\|register\|unregister\|show` | Manage oracle profiles |
| `session` `<id>` | Show a past consult session |
| `status` | List recent sessions |
| `skill` `list\|install` | Manage installed skills |
| `github` `check\|pr\|issue\|search\|get` | GitHub PR/issue access |
| `identity` `show\|setup`, `persona`, `forget` | Identity and persona management |
| `login` / `logout` | Anthropic OAuth |
| `doctor` | Check provider wiring |
| `setup-mcp` | Generate MCP client config (`--client claude-code\|codex`) |

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

## Smart memory

Oracle's memory system uses ML-inspired algorithms to surface the **most relevant** information automatically.

| Feature | Description |
|---|---|
| **Recency-weighted scoring** | Memories accessed often or recently rank higher — formula: `semantic×0.6 + importance×0.2 + recencyBoost×0.15 + freqBoost×0.05` |
| **Entity knowledge graph** | Extracts entities (technologies, projects, people) from memory content, builds typed relationship edges, and expands search queries with related entities |
| **Auto-consolidation** | Finds similar memories by tag overlap (Jaccard ≥ 0.3) and merges them — reduces clutter without data loss |
| **Access tracking** | Every `recall`/`scored_search` bump increments `accessCount` and updates `lastAccessed` — unused memories decay |
| **Background maintenance** | `prune` removes stale low-value memories (30d untouched + importance < 0.2), `promote` graduates frequently-retrieved working memories into durable `insight` |
| **LLM reflection** | Clusters related memories and asks Claude to synthesize new higher-level insights — requires `ANTHROPIC_API_KEY` + `ORACLE_MEMORY_LLM_GRAPH=1` |

Memory data lives in `.oracle-memory/` — compatible with the standalone `oracle-memory` MCP server.

## MCP tools (37)

**Agent**
`oracle_agent` (supports `skill` parameter: review, debug, security, architecture, tests)

**Ask**
`oracle_ask`

**Memory**
`oracle_memory_list`, `oracle_memory_search`, `oracle_memory_update`,
`oracle_memory_stats`, `oracle_memory_clear`, `oracle_memory_scored_search`

**Entity graph**
`oracle_memory_graph_query`, `oracle_memory_graph_path`,
`oracle_memory_graph_stats`

**Consolidation & maintenance**
`oracle_memory_consolidate`, `oracle_memory_prune`, `oracle_memory_promote`,
`oracle_memory_maintenance`

**Reflection**
`oracle_memory_reflect`

**Memory wiki**
`oracle_memory_wiki_build`, `oracle_memory_wiki_list`, `oracle_memory_wiki_get`

**Docs**
`oracle_docs_list`, `oracle_docs_search`, `oracle_docs_add`, `oracle_docs_remove`

**Web**
`oracle_web_search`, `oracle_web_fetch`, `oracle_web_extract`

**Oracle profiles**
`oracle_oracle_list`, `oracle_oracle_register`

**Identity / persona**
`oracle_identity_show`, `oracle_identity_setup`, `oracle_persona_set`

**Sessions / skills / health**
`oracle_sessions`, `oracle_session_get`, `oracle_skills`, `oracle_doctor`

**Agent tools** (autonomous task execution)
- File operations: `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`
- Search: `grep`
- Shell: `bash`
- **Multimodal:** `read_image` (PNG/JPEG/GIF/WebP), `read_video` (MP4/WebM)

## Autonomous Agent

Oracle runs agentic tasks with tool-use loops — the agent autonomously calls
tools, processes results, and iterates toward a goal. Supports multimodal input
(images, videos) when using Claude models.

**Features:**
- **File access:** read/write/edit files, list directories, search with glob/grep
- **Shell execution:** bash commands (builds, tests, git, etc.)
- **Multimodal input:** agents can read and analyze images/videos from the workspace
- **Skills:** apply engineering best practices (review, debug, security, architecture, tests)
- **MCP integration:** agent discovers and uses tools from external MCP servers

**Usage:**
```bash
oracle agent "fix the failing tests" --skill debug
```

Or via MCP:
```json
{
  "prompt": "Review this code for security issues",
  "skill": "security"
}
```

## Configuration

Project config lives in `.oracle/config.json`:

```json
{
  "provider": "codex",
  "model": "gpt-5.4-mini",
  "include": ["src/**/*", "README.md", "package.json"],
  "exclude": ["**/*.test.ts", "**/node_modules/**", "**/dist/**"],
  "maxFileSizeBytes": 1000000,
  "maxInputBytes": 5000000,
  "mcpServers": [
    {
      "name": "your-mcp-server",
      "url": "http://localhost:3000"
    }
  ]
}
```

**Config fields:**
- `provider` — `codex`, `openai`, `anthropic`, or `opencode`
- `model` — model ID (e.g., `gpt-5.4-mini`, `claude-sonnet-5`)
- `include` / `exclude` — file patterns for context window
- `mcpServers` — external MCP servers to wire into the agent (stdio or HTTP)

Environment variables:

| Var | Purpose |
|---|---|
| `ORACLE_WORKSPACE_ROOT` | Project root the MCP server operates on |
| `ORACLE_HOME_DIR` | Override the `~/.oracle` home (sessions, profiles, config) |
| `ORACLE_USE_OLLAMA` | Enable semantic memory search via Ollama embeddings (`"1"` or `"true"`) |
| `ORACLE_MEMORY_BIN` | Path to `oracle-memory` binary (default: `oracle-memory`) |
| `ORACLE_MEMORY_LLM_GRAPH` | Enable LLM-powered entity extraction, conflict detection, and reflection (requires `ANTHROPIC_API_KEY`) |
| `ORACLE_WEB_LOG` | Set to `"0"` to disable web search/fetch logging |
| `OLLAMA_HOST` | Ollama endpoint (default `http://127.0.0.1:11434`) |
| `OLLAMA_EMBED_MODEL` | Embedding model (default `nomic-embed-text`) |
| `BRAVE_API_KEY` | Brave Search API key |
| `TAVILY_API_KEY` | Tavily Search API key |
| `FIRECRAWL_API_KEY` | Firecrawl API key (JS-rendered page scraping) |
| `AGENTQL_API_KEY` | TinyFish AgentQL key (structured data extraction) |

Provider API keys are read from the environment / `.env` (see `oracle doctor`):

| Provider | Required Env Vars |
|---|---|
| `codex` | Codex CLI installed and authenticated |
| `openai` | `OPENAI_API_KEY`, optionally `OPENAI_API_BASE` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `opencode` | `OPENCODE_API_KEY` (or `OPENAI_API_KEY`), `OPENCODE_API_BASE`, `OPENCODE_MODEL` |
