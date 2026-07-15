# Mini Oracle v1

A small, runnable implementation of the core idea behind `@steipete/oracle`:

1. resolve project files and globs
2. bundle prompt + file context
3. call an expert model
4. persist a replayable session
5. expose the same core through CLI and MCP

This starter intentionally omits browser automation, multi-model fan-out,
remote browser control, TUI, project sources, and image workflows.

## Requirements

- Node.js 24+
- Codex CLI authenticated with `codex login` (default), or an OpenAI API key

## Install

```bash
npm install
npm run build
```

Authenticate the default local provider:

```bash
codex login
node dist/cli.js doctor
```

To use the OpenAI API provider instead, set `OPENAI_API_KEY` and pass
`--provider openai`.

## CLI

```bash
node dist/cli.js consult \
  -p "Review this code for correctness and concurrency risks" \
  -f "src/**/*.ts" "!src/**/*.test.ts"
```

Codex is the default provider and runs read-only with your existing ChatGPT
login. Common credential formats are blocked before any provider is called.
Use OpenAI explicitly when needed:

```bash
node dist/cli.js consult --provider openai \
  -p "Review this code" -f "src/**/*.ts"
```

```bash
node dist/cli.js status
node dist/cli.js session <session-id>
```

Sessions are stored at:

```text
~/.mini-oracle/sessions/<session-id>/
├── bundle.md
├── output.md
└── session.json
```

## MCP

```bash
node dist/mcp.js
```

Example `.mcp.json`:

```json
{
  "mcpServers": {
    "mini-oracle": {
      "command": "node",
      "args": ["/absolute/path/to/mini-oracle-v1/dist/mcp.js"],
      "env": {
        "ORACLE_WORKSPACE_ROOT": "/absolute/path/to/project",
        "ORACLE_PROVIDER": "codex"
      }
    }
  }
}
```

MCP callers cannot replace the workspace root. If `ORACLE_WORKSPACE_ROOT` is
omitted, the server uses its startup working directory.

## Next steps

1. add Anthropic and Gemini provider adapters
2. add `--models` using `Promise.allSettled`
3. add token estimation and hard budgets
4. implement full `.gitignore` semantics
5. add secret scanning/redaction before bundling
6. add a follow-up command using `previous_response_id`
7. add dry-run/render/copy modes
8. only then consider browser automation
