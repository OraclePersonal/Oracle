# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Persistent cron task system (`oracle schedule`) with `list`, `add`, `remove`, `run`, `watch`, `--once` commands
- Agent checkpoint store with list/resume/delete support
- Agent plan mode (`--plan`) for read-only investigation before execution
- Agent self-review mode (`--review`) for post-completion correctness checks
- Agent resume from checkpoint (`--resume <id>`) after `--max-steps` or crash
- Agent JSON output mode (`--json`) for structured `finalText`, `steps`, `checkpointId`
- Bash tool with `$SHELL` respect (Git Bash on Windows, user shell on Unix)
- Codex CLI provider integration
- Cross-tool session history recall (`oracle_history_sources`, `oracle_history_search`)
- `oracle_msg_search` — time-first recall over the whole message bus
- tmux real-time push watcher (`scripts/oracle-tmux-launch.sh`, `scripts/oracle-tmux-push-watcher.mjs`)
- `oracle msg watch` with `--exec` for custom nudge commands
- `oracle msg inbox` blocking wait mode (`--wait --timeout`)
- AST graph memory module (`src/memory/astGraph.ts`)
- Memory decay module (`src/memory/decay.ts`)
- Agent policy module (`src/agent/policy.ts`)
- Task consensus module (`src/tasks/consensus.ts`)
- Observability audit trail (`src/observability/audit.ts`)
- Multi-agent swarm execution (`src/orchestrator/swarm.ts`)
- Scheduler docs (`docs/scheduler.md`)
- LICENSE, CONTRIBUTING.md, SECURITY.md, SUPPORT.md at repo root
- CLI reference (`docs/cli-reference.md`) and troubleshooting guide (`docs/troubleshooting.md`)
- Signatures on all docs
- Updated `docs/AGENT.md` with plan/review/resume/JSON flags
- Updated `docs/MCP-STANDARDS.md` to reflect 49 tools, removed GitHub tools section
- Updated `docs/index.md` as a real GitHub Pages landing page

### Changed
- `docs/AGENT.md` — rewritten with current CLI flags, checkpoint/resume, self-review, source map
- `docs/MCP-STANDARDS.md` — rewritten with 49 tools, new categories, error handling checklist
- `docs/index.md` — fixed duplicate entries, added CLI Reference and Troubleshooting links
- Moved `MESSAGING.md` out of `package.json` files array (now only in `docs/`)

### Removed
- `oracle_github_*` tools from all documentation
- Duplicate "Superpowers / Plans" entry from docs/index.md
- `docs/` folder restructure — moved root docs into `docs/` for GitHub Pages
- `docs/index.md` reordered documentation table (new user → deeper reference)
- `docs/MESSAGING.md` relative link fixes from root to `docs/`

### Changed
- MCP tools reorganized into category files under `src/mcp/tools/`
- `CheckpointStore` renamed to `FileCheckpointStore` in agent module
- Agent loop supervisor timeout behavior hardened against fast-fallback hangs
- Agent stdout pollution prevented in orchestrator
- `package.json` files array updated to include `docs`
- README and docs links updated to use `docs/` relative paths

### Fixed
- `oracle_msg_inbox` wait mode timeout and re-arm behavior
- Agent `stdout` pollution breaking MCP protocol framing
- Fast-fallback orchestrator supervisor timeouts
- Windows bash tool shell selection (`$SHELL` fallback)
- Built CLI import paths for the swarm and audit commands
- Swarm workflow state now persists across separate CLI invocations
- Task consensus proposals and votes now persist and accumulate
- Agent tool and policy-denial events now populate `.oracle/audit.jsonl`
- Agent policy loading now fails closed and enforces mutation limits
- Message inbox ordering is deterministic for rapid sequential sends

## [0.0.2] - 2026-07-24

### Added
- Agent resume, plan mode, JSON output, self-review, checkpoint list
- Bash tool and codex agent provider
- Cross-tool session-history recall
- `oracle_msg_search` time-first recall
- tmux real-time push for idle sessions
- 4-tier wake-up model documentation and implementation
- `oracle msg watch` CLI command
- `oracle msg inbox` wait mode
- Agent checkpoint system
- Task planning, tracking, and verification layer
- MCP tool category extraction and error recovery
- Docs: worked example (standby workers + tmux push)
- Docs: 4-tier wake-up model
- Docs: agent flags (plan, review, resume, json, checkpoints)
- Docs: Oracle MCP setup guide and Claude Code integration
- Docs: GitHub Pages content rewrite to match current Oracle
- Repo flatten — `Oracle/` subfolder contents moved to repo root

### Changed
- Agent and messaging tooling matured from prototype to production-ready
- Docs restructured to match current CLI surface

## [0.0.1] - 2026-07-15

### Added
- Initial release: MCP server + CLI with memory, consultation, agent, messaging, and task tracking
- Persistent memory with BM25 + vector search + entity graph
- Consultation engine (`oracle ask`) with code/memory/docs/web context
- Autonomous agent sandbox with audit trail
- Inter-agent message bus (`oracle msg`)
- Task planning & verification (`oracle task`)
- Identity and persona system
- GitHub integration tools
- Docs & web tools
- Session history recall tools
- Oracle profiles & skills system
