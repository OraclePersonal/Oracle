# Oracle Agent — Autonomous Coding Loop

Oracle can act as an autonomous coding agent, the same way Claude Code and
opencode do: you give it a task, and it reads, writes, and edits files,
searches the codebase, and runs shell commands in a **tool-use loop** until the
task is complete. This document explains how it works, the toolset, safety
boundaries, and how to use it from the CLI and MCP.

## How it works

```
task ──► [ provider.runAgentTurn ] ──► assistant text + tool calls
              ▲                               │
              │                               ▼
        tool results  ◄──── [ execute each tool in the workspace ]
              │                               │
              └───────────────  loop  ◄───────┘
                    (until no tool calls, or maxSteps reached)
```

1. The task becomes the first user message.
2. The provider returns assistant text plus zero or more **tool calls**.
3. Each tool call is executed against the workspace; results are fed back.
4. The loop repeats until the model stops calling tools (it's done) or the
   `maxSteps` cap is hit.

The loop itself (`src/agent/loop.ts`) is **provider-agnostic**. Each provider
translates the neutral transcript to/from its own wire format:

- **Anthropic** — native `tool_use` / `tool_result` blocks (`src/providers/anthropic.ts`)
- **opencode** (OpenAI-compatible) — chat-completion function calling (`src/providers/openai.ts`)

`codex` and the `openai` responses provider do **not** support the agentic loop
today; the agent requires `anthropic` or `opencode`.

## Toolset

All tools live in `src/agent/tools.ts`. Filesystem access is confined to the
workspace root — a single trust boundary (`resolveInWorkspace`) rejects any
path that escapes it.

| Tool | Mutating | Purpose |
|---|---|---|
| `read_file` | no | Read a UTF-8 file (truncated if very large) |
| `list_dir` | no | List a directory's immediate entries |
| `glob` | no | Find files whose path contains a substring |
| `grep` | no | Search file contents; returns `path:line: text` |
| `write_file` | yes | Create/overwrite a file (makes parent dirs) |
| `edit_file` | yes | Replace an exact, unique string in a file |
| `bash` | yes | Run a shell command in the workspace (timeout + output cap) |

## Safety boundaries

- **Workspace confinement** — every path is resolved against the workspace root;
  traversal outside it (`../`) is rejected before any I/O happens.
- **Read-only mode** — pass `readOnly` (MCP) or `--read-only` (CLI) to drop all
  mutating tools (`write_file`, `edit_file`, `bash`) entirely, so the agent can
  investigate without changing anything.
- **Step cap** — `maxSteps` (default 20) bounds the loop so it can't run forever.
- **Output cap** — each tool truncates its output (30k chars) so a huge file or
  command can't blow up the context.
- **bash** runs with a timeout (default 120s) and is killed if it overruns.

The agent operates on the user's own workspace intentionally; it does not redact
file contents (the model needs real code to edit). Use `readOnly` when you only
want analysis.

## CLI usage

```bash
# Implement something (writes files, runs tests)
oracle agent "add a --verbose flag to the CLI and update the README"

# Investigate without touching anything
oracle agent "explain how sessions are persisted" --read-only

# Pick provider/model and bound the loop
oracle agent "fix the failing test in src/foo.test.ts" \
  --provider anthropic --model auto --max-steps 30
```

Progress is printed to stderr per turn (`[turn 3] → read_file, edit_file`); the
final answer goes to stdout.

## MCP usage

The `oracle_agent` tool exposes the same capability to any MCP client:

```jsonc
{
  "name": "oracle_agent",
  "arguments": {
    "prompt": "add input validation to the config loader and a test for it",
    "readOnly": false,   // optional; true = investigate only
    "maxSteps": 20        // optional; 1..50
  }
}
```

Structured result:

```jsonc
{
  "finalText": "Added zod validation … and a passing test.",
  "turns": 6,
  "stoppedOnLimit": false,
  "steps": [ { "turn": 1, "text": "...", "toolsUsed": ["read_file"] }, ... ],
  "usage": { "inputTokens": 12000, "outputTokens": 3400 }
}
```

If the configured provider can't run the agent, `oracle_agent` returns an
`ORACLE_AGENT_UNAVAILABLE` error explaining that you need `anthropic` or
`opencode` (set it in `.oracle/config.json` or via `--provider`).

Long runs emit MCP progress notifications (one per turn) when the client passes
a progress token.

## Configuration

Set the provider in `.oracle/config.json`:

```json
{
  "provider": "anthropic",
  "model": "auto"
}
```

- `anthropic` — uses `ANTHROPIC_API_KEY` or an OAuth session (`oracle login --provider anthropic`). `model: "auto"` picks the best model for your subscription tier.
- `opencode` — any OpenAI-compatible endpoint via `OPENCODE_API_KEY` / `OPENCODE_API_BASE` / `OPENCODE_MODEL`.

## Source map

| File | Responsibility |
|---|---|
| `src/agent/types.ts` | Neutral types (`AgentMessage`, `ToolCall`, `AgentTool`, `AgentProvider`) |
| `src/agent/tools.ts` | The 7 tool executors + workspace confinement |
| `src/agent/loop.ts` | Provider-agnostic tool-use loop |
| `src/agent/service.ts` | `AgentService` — wires tools + provider, runs the loop |
| `src/providers/anthropic.ts` | `runAgentTurn` via native tool use |
| `src/providers/openai.ts` | `runAgentTurn` via OpenAI function calling (opencode) |
| `src/mcp/server.ts` | `oracle_agent` MCP tool |
| `src/cli.ts` | `oracle agent` command |
