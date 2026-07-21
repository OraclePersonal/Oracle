# Codex Provider and Input Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Mini Oracle through locally authenticated Codex by default while blocking common secrets and binding MCP file access to one workspace.

**Architecture:** Add a process-backed provider with dependency-injected command execution, a standalone secret scanner invoked after file reads, and a provider factory/preflight layer shared by CLI and MCP. MCP captures its root at startup and never accepts a caller-controlled root.

**Tech Stack:** TypeScript 6, Node.js 24+, Vitest, Commander, MCP SDK, OpenAI SDK, Codex CLI 0.144+.

## Global Constraints

- Keep OpenAI API support as an explicit alternative.
- Codex runs read-only and ephemeral, with prompts on stdin.
- Never include detected secret values in errors or sessions.
- Do not commit `graphify-out/`; do commit `package-lock.json`.
- Implement behavior test-first.

---

### Task 1: Secret scanner

**Files:**
- Create: `src/context/secrets.ts`
- Create: `src/context/secrets.test.ts`
- Modify: `src/core/consult.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Produces: `scanFilesForSecrets(files: ContextFile[]): SecretFinding[]`
- Produces: `SecretFinding { path: string; line: number; detector: string }`

- [ ] Write tests for private-key blocks, token prefixes, sensitive assignments, placeholders, and non-disclosure of values.
- [ ] Run `npm test -- src/context/secrets.test.ts` and verify expected failures.
- [ ] Implement high-confidence line-based detectors and throw a sanitized consultation error before session/provider work.
- [ ] Run scanner and consult tests until green.

### Task 2: Codex CLI provider and preflight

**Files:**
- Create: `src/providers/codex.ts`
- Create: `src/providers/codex.test.ts`
- Create: `src/providers/factory.ts`
- Create: `src/providers/factory.test.ts`
- Modify: `src/providers/provider.ts`
- Modify: `src/providers/openai.ts`
- Modify: `src/core/consult.ts`
- Modify: `src/types.ts`

**Interfaces:**
- `ProviderRequest` gains `cwd: string`.
- `CodexCliProvider.run(request): Promise<ProviderResponse>` invokes `codex exec` using stdin and a temporary output file.
- `createProvider(name: "codex" | "openai"): Provider` selects the adapter.
- `checkProvider(name): Promise<DoctorCheck[]>` reports executable/login/key readiness.

- [ ] Write failing tests using an injected process runner to assert exact safe arguments, stdin, output capture, cleanup, and errors.
- [ ] Run targeted tests and confirm failures.
- [ ] Implement the minimal process runner and provider factory; reject Codex follow-up IDs explicitly.
- [ ] Run targeted tests until green.

### Task 3: CLI and MCP integration

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/mcp.ts`
- Modify: `src/mcp.test.ts`
- Create: `src/cli-options.test.ts`

**Interfaces:**
- CLI `consult --provider <codex|openai>` defaults to `codex`.
- CLI `doctor --provider <codex|openai>` prints readiness and exits nonzero on failure.
- MCP uses `ORACLE_WORKSPACE_ROOT ?? process.cwd()` and `ORACLE_PROVIDER ?? "codex"` captured at startup.

- [ ] Write failing source/API boundary tests for provider defaults, doctor, and fixed MCP root.
- [ ] Run targeted tests and confirm failures.
- [ ] Wire the factory into both entrypoints and add doctor output.
- [ ] Run targeted tests until green.

### Task 4: Runtime, docs, and repository hygiene

**Files:**
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `package.json`
- Include: `package-lock.json`

- [ ] Ignore `graphify-out/` and document Codex login/default provider, OpenAI alternative, secret blocking, MCP root, and Node 24.
- [ ] Add `preflight` script that rejects Node versions below 24 and runs before build/test commands.
- [ ] Refresh the lockfile under Node 24.

### Task 5: Verification and commit

- [ ] Run all tests, typecheck, and build under Node 24.
- [ ] Run `doctor` for Codex and confirm ChatGPT authentication.
- [ ] Run one real Codex consultation against a small repository file and verify the persisted session.
- [ ] Review the final diff and run simplification/correctness review.
- [ ] Stage only intended replacement-project files, excluding generated output and credentials.
- [ ] Commit with a message describing the runnable secure Mini Oracle core and Codex integration.
