# Contributing to Oracle

Thanks for your interest in contributing! This guide covers the development
setup, branch strategy, commit conventions, and review expectations.

## Prerequisites

- Node.js ≥ 24
- npm (comes with Node.js)
- Git
- A GitHub account

## Clone and install

```bash
git clone https://github.com/OraclePersonal/Oracle.git
cd Oracle
npm install
```

## Build and verify

```bash
npm run build          # compile TypeScript → dist/
npm run typecheck      # tsc --noEmit (fast, no emit)
npm test               # run vitest
```

263 tests cover messaging, memory, agent sandbox, bash tool, and MCP integration.

## Branch strategy

- `main` is the default branch; PRs target `main`.
- Branch from `main` for each feature or fix: `feat/scheduler-watch`, `fix/agent-resume-crash`.

## Commit conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add schedule watch daemon
fix: prevent checkpoint write race on crash
docs: update AGENT.md with plan/review flags
test: cover scheduler cron expression validation
```

Every commit must pass `npm run typecheck && npm test`.

## Code style

- TypeScript strict mode, ESM, `NodeNext` module resolution
- 2-space indent, double quotes, semicolons required
- `node:` prefix for built-in modules, `.js` extensions for relative imports
- Return `{ ok, summary, data }` from all tools

## Before opening a PR

1. Run `npm run typecheck && npm test` — both must pass clean.
2. Update docs in `docs/` and `README.md` if the change is user-visible.
3. Add an entry to `CHANGELOG.md` under `[Unreleased]`.
4. Open the PR against `main` with a clear title and description.

## Reporting bugs

Open a GitHub Issue with:
- Oracle version (`oracle --version` or git commit hash)
- Node.js version (`node --version`)
- Provider in use (`oracle doctor` output)
- Steps to reproduce
- Expected vs actual behavior

## Security

See [SECURITY.md](SECURITY.md) for the security policy and how to report
vulnerabilities privately.

---
*Oracle — A persistent coordination layer for AI coding agents*
*https://github.com/OraclePersonal/Oracle*
