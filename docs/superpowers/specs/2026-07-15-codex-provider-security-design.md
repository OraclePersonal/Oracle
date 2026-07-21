# Codex Provider and Input Security Design

## Goal

Make Mini Oracle usable without an API key through the locally authenticated Codex CLI, while preventing selected repository files from leaking common secrets and keeping MCP file access bound to a configured workspace.

## Provider architecture

Add `CodexCliProvider` beside `OpenAIProvider`. CLI provider selection is `codex` by default and `openai` when explicitly requested. Codex runs non-interactively with the bundled prompt on stdin, `--sandbox read-only`, `--ephemeral`, `--cd <workspace>`, and `--output-last-message <temporary file>`. It reuses `codex login` authentication. Its response has no token usage or Responses API ID.

`ProviderRequest` gains `cwd` so process-backed providers receive an explicit workspace root. OpenAI ignores it. Codex rejects `previousResponseId` until a separate resume design exists.

## File security

After resolving and reading files, scan text for high-confidence credential formats and sensitive assignment keys. If any finding exists, abort before bundle creation, session persistence, or provider execution. Return only file path, line number, and detector name; never include the secret value. Keep filename ignores as the first filter.

Initial detectors cover private-key blocks, common provider token prefixes, and assignments whose key contains password, secret, token, api key, or client secret. Placeholder/example values are allowed when clearly non-secret.

## MCP workspace

MCP callers cannot pass `cwd`. The server captures `ORACLE_WORKSPACE_ROOT` when set, otherwise its startup working directory, resolves it once, and passes it into every consultation. Existing containment checks prevent resolved files from escaping this root.

## Preflight and CLI

Add a `doctor` command that reports Node compatibility and provider readiness. Codex readiness checks executable availability and `codex login status`; OpenAI readiness checks `OPENAI_API_KEY`. `consult` performs the selected provider's preflight and produces actionable errors.

Node 24 remains the supported runtime. Verification must run under Node 24; the local Node 23 shell is not treated as supported even if compilation happens to pass.

## Repository hygiene

Commit `package-lock.json`. Ignore generated `graphify-out/`; do not delete or commit its contents. The TypeScript project intentionally replaces the previous Python Oracle database prototype.

## Testing and acceptance

Use unit tests for Codex process invocation, output/error handling, secret detection, provider selection, doctor status, and MCP workspace binding. Run all tests, typecheck, and build under Node 24. Finally run one real consultation through the installed and ChatGPT-authenticated Codex CLI and confirm its session is persisted, then commit only intended files.
