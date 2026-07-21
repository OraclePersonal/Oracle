# MCP-First Usability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Mini Oracle into a project-configured MCP service with focused tools, presets, structured errors, setup automation, and stdio integration coverage.

**Architecture:** Load and validate immutable project settings at MCP startup, then construct an injectable MCP server around existing consultation, provider, and session services. Keep config, presets, errors, setup generation, and server registration in focused modules with test-first boundaries.

**Tech Stack:** Node.js 24+, TypeScript 6, Zod 4, MCP SDK 1.29, Commander 15, Vitest 4, Codex CLI.

## Global Constraints

- MCP root is captured from `ORACLE_WORKSPACE_ROOT` or startup cwd and never caller-controlled.
- Default provider/model are `codex` and `gpt-5.4`.
- Expected errors use stable codes and never expose secret values or bundle contents.
- Input is limited to 5 MB by UTF-8 byte count.
- Setup writes project-local configuration only and never silently overwrites conflicts.
- Browser, TUI, multi-model, remote control, and follow-up conversations remain out of scope.

---

### Task 1: Project config and presets

**Files:** Create `src/config/project.ts`, `src/config/project.test.ts`, `src/presets.ts`, `src/presets.test.ts`.

**Interfaces:** `loadProjectConfig(root): Promise<ProjectConfig>`, `DEFAULT_PROJECT_CONFIG`, `PresetName`, `composePresetSystemPrompt(preset, base)`.

- [ ] Write failing tests for missing config defaults, valid config, unknown keys, invalid limits/providers/patterns, and all five preset instructions.
- [ ] Run `npm test -- src/config/project.test.ts src/presets.test.ts` and confirm missing-module failures.
- [ ] Implement strict Zod parsing, safe path resolution, immutable defaults, and static preset composition.
- [ ] Run targeted tests and confirm green.

### Task 2: Stable domain errors and consultation guards

**Files:** Create `src/errors.ts`, `src/errors.test.ts`; modify `src/core/consult.ts`, `src/types.ts`; create `src/core/consult.test.ts`.

**Interfaces:** `OracleError`, `OracleErrorCode`, `serializeOracleError(error)`, request metadata for provider/preset, 5 MB `maxInputBytes`.

- [ ] Write failing tests for safe serialization, no files, secret detection, byte budget, and persisted provider/preset metadata.
- [ ] Run targeted tests and verify failures.
- [ ] Implement minimal error mapping and guards before session/provider work.
- [ ] Run targeted tests and confirm green.

### Task 3: Focused MCP server and four tools

**Files:** Create `src/mcp/server.ts`, `src/mcp/server.test.ts`; reduce `src/mcp.ts` to startup; modify session store/types as required.

**Interfaces:** `createOracleMcpServer(dependencies)`, tools `oracle_consult`, `oracle_sessions`, `oracle_session_get`, `oracle_doctor`; compact session summaries and structured outputs.

- [ ] Write failing in-memory/server tests for schemas, config fallback files, preset composition, session list/get, doctor checks, and structured expected errors.
- [ ] Run tests and confirm failures.
- [ ] Implement injectable server registration and thin stdio entrypoint.
- [ ] Run targeted tests and confirm green.

### Task 4: Setup command

**Files:** Create `src/setup/mcp.ts`, `src/setup/mcp.test.ts`; modify `src/cli.ts`.

**Interfaces:** `setupMcp({ root, client, print, force }): Promise<SetupResult>`, JSON generator for `.mcp.json`, TOML generator for `.codex/config.toml`, atomic writes.

- [ ] Write failing tests for print-only, initial files, merge preservation, conflict refusal, force replacement, and absolute server/root paths.
- [ ] Run targeted tests and confirm failures.
- [ ] Implement setup generation and `oracle setup-mcp` options.
- [ ] Run targeted tests and confirm green.

### Task 5: Stdio integration, docs, and acceptance

**Files:** Create `src/mcp/integration.test.ts`; modify `README.md`, `.gitignore` if needed.

- [ ] Add an MCP client integration test that starts built stdio server in a temporary workspace and exercises all four tools with deterministic provider behavior.
- [ ] Document config, tools, setup flows, errors, and examples.
- [ ] Run all tests, typecheck, and build.
- [ ] Run `oracle setup-mcp --print`, `oracle doctor`, and one real `oracle_consult` through stdio with local Codex authentication.
- [ ] Review changes, commit intended files, and report evidence.
