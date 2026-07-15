# MCP-First Usability Design

## Goal

Make Mini Oracle predictable and self-describing for coding agents: one project setup, four focused MCP tools, stable structured errors, project-scoped defaults, and an end-to-end tested stdio server.

## Scope

This phase covers MCP configuration, setup, presets, session discovery, provider diagnosis, structured results, and agent-actionable errors. It does not add browser automation, a TUI, multi-model execution, remote control, or provider-specific follow-up conversations.

## Project configuration

Each project may contain `.oracle/config.json`:

```json
{
  "provider": "codex",
  "model": "gpt-5.4",
  "include": ["src/**/*", "README.md", "package.json"],
  "exclude": ["**/*.test.ts", "**/dist/**"],
  "maxFileSizeBytes": 1000000
}
```

The MCP server resolves its root once from `ORACLE_WORKSPACE_ROOT`, falling back to its startup directory. It loads only `<root>/.oracle/config.json`. Unknown keys, unsupported providers, empty model names, invalid patterns, and non-positive limits fail startup with `ORACLE_CONFIG_INVALID`.

If the config file is absent, defaults are provider `codex`, model `gpt-5.4`, include `src/**/*`, `README.md`, and `package.json`, exclude test/build/dependency paths, and a 1 MB file limit.

Callers may supply a narrower file list per consultation. They cannot change root, provider, model, exclusions, or file-size limits through MCP. Explicit files are still combined with configured exclusions and containment/security checks.

## Presets

Supported presets are `review`, `debug`, `architecture`, `tests`, and `security`. A preset contributes a short system instruction before the caller prompt; it does not modify files or provider selection. `review` is the default. Preset definitions are static, versioned source code and independently tested.

## MCP tools

### `oracle_consult`

Input:

```json
{
  "prompt": "Find the root cause of the race condition",
  "preset": "debug",
  "files": ["src/router.ts"]
}
```

`prompt` is required. `preset` defaults to `review`. `files` is optional; omitted files use config include patterns. The server emits progress notifications at file resolution, provider invocation, and session persistence when the connected client supports MCP progress tokens.

Successful structured output includes the full model output plus `sessionId`, `status`, `model`, `provider`, `preset`, included file paths/count, usage, and timestamps. Text content contains the model output for clients that ignore structured content.

### `oracle_sessions`

Input accepts an optional integer limit from 1 through 100, default 20. Output contains compact session summaries sorted newest first: session ID, status, model, created/completed time, file count, and a truncated prompt preview. It never returns bundled source content.

### `oracle_session_get`

Input requires a session ID matching the generated session-ID format. Output returns session metadata and model output, but never `bundle.md` contents. Missing sessions return `ORACLE_SESSION_NOT_FOUND`.

### `oracle_doctor`

No input. Output reports config validity, workspace accessibility, provider executable/authentication readiness, session-store writability, and Node compatibility. Each check has `name`, `ok`, and `detail`; overall status is unhealthy if any required check fails.

## Error contract

All expected failures use a shared `OracleError` shape:

```json
{
  "code": "ORACLE_SECRET_DETECTED",
  "message": "Potential secrets were detected in selected files.",
  "suggestion": "Remove the files from the selection or replace credentials with placeholders.",
  "details": {
    "findings": [{ "path": "config.ts", "line": 4, "detector": "sensitive-assignment" }]
  }
}
```

Stable codes in this phase:

- `ORACLE_CONFIG_INVALID`
- `ORACLE_PROVIDER_UNAVAILABLE`
- `ORACLE_NO_FILES`
- `ORACLE_SECRET_DETECTED`
- `ORACLE_INPUT_TOO_LARGE`
- `ORACLE_SESSION_NOT_FOUND`
- `ORACLE_INVALID_REQUEST`
- `ORACLE_INTERNAL_ERROR`

Expected errors set MCP `isError: true` and provide the same object in text JSON and structured content. Secret values, environment values, command output containing credentials, and bundle contents are never included.

## Setup command

`oracle setup-mcp` initializes project integration:

```text
oracle setup-mcp --client claude-code
oracle setup-mcp --client codex
oracle setup-mcp --print
```

It accepts `--cwd`, defaulting to the current directory. It performs provider preflight, creates `.oracle/config.json` only when absent, and generates an MCP entry using the absolute built `dist/mcp.js` path plus `ORACLE_WORKSPACE_ROOT` and `ORACLE_PROVIDER`.

`--print` writes JSON to stdout and changes no client configuration. Client modes write only the project-local MCP configuration supported by that client. If an existing file contains unrelated servers, setup merges the `mini-oracle` entry. If that entry already differs, setup stops with an actionable conflict unless `--force` is explicitly supplied. Config writes use a temporary file followed by rename to avoid partial files.

Codex project MCP output targets `.codex/config.toml`; Claude Code project MCP output targets `.mcp.json`. Setup never edits user-global configuration.

## Internal boundaries

- `src/config/project.ts`: schema, defaults, loading, and validation.
- `src/presets.ts`: preset names and prompt composition.
- `src/errors.ts`: stable error codes and safe serialization.
- `src/mcp/server.ts`: server construction and tool registration, injectable for tests.
- `src/mcp.ts`: minimal stdio entrypoint only.
- `src/setup/mcp.ts`: config generation and atomic project-local writes.
- Existing `ConsultService`, providers, file resolver, secret scanner, and session store remain focused services used by the MCP layer.

`ConsultResult` gains provider and preset metadata. Session records persist these fields so listing and retrieval remain self-contained.

## Data flow

1. Entrypoint captures workspace root and loads validated project config.
2. MCP tool validates request input.
3. Tool selects explicit files or configured includes, always appending configured exclusions.
4. Preset system instruction and caller prompt are composed.
5. `ConsultService` resolves bounded files, rejects zero files, scans secrets and input budget, creates a session, invokes the configured provider, and persists the result.
6. MCP maps the domain result or `OracleError` into text and structured output.

Input budget for this phase is byte-based: sum of selected UTF-8 file sizes plus prompt bytes must not exceed 5 MB. This deterministic guard precedes later token estimation.

## Testing and acceptance

Unit tests cover config defaults/validation, preset composition, safe error serialization, setup generation/merge/conflict behavior, session summaries, and tool schemas. Domain tests cover no-files, secret, and byte-budget errors.

An integration test starts the built MCP server through stdio with a temporary workspace and fake provider executable, initializes an MCP client, and calls all four tools. It verifies structured success/error responses and session persistence.

Final acceptance requires tests, typecheck, and build under Node 24+, `oracle doctor`, `oracle setup-mcp --print`, and one real MCP `oracle_consult` invocation using the locally authenticated Codex CLI without modifying project files.
