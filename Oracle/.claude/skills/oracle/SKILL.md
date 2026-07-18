---
name: oracle
description: Use when working in this repo (Oracle CLI/MCP project) and the task involves consulting an expert model on code, remembering/recalling project knowledge, managing identity/persona, or coordinating with other agents via the peer message mesh. Covers the oracle_* MCP tool surface registered by src/mcp/server.ts — distinct from the external oracle-messages/oracle-memory servers (those use onboard/remember/recall/send_message tool names instead).
---

# Oracle Skill (this repo's own MCP server)

This project registers its own MCP tools under the `oracle_*` prefix (see
`src/mcp/server.ts`). It bundles four capabilities in one server — no
separate oracle-messages / oracle-memory processes required:

- **Consult** — send project files + a prompt to an expert model (codex/openai/anthropic).
- **Memory** — `.oracle-memory/` fact/insight/chunk/working entries, scoped per agent.
- **Identity** — your profile + Oracle's persona, auto-injected into every consult.
- **Peer mesh** — `.oracle/messages/` file-backed bus for agent-to-agent messages.

Do not confuse this with the `Oracle-skill` doc for the standalone
`oracle-messages`/`oracle-memory` servers — those expose `onboard`,
`remember`, `recall`, `send_message`, `wait_for_message` etc. This repo's
tools are always prefixed `oracle_` and are self-contained.

## 0. Setup (once per workspace)

```bash
oracle setup-mcp --client claude-code
```

This registers the built server (`oracle.js`) with Claude Code. After that,
all tools below appear natively in the session — no separate process to run.

## 1. Session-start sequence

```
1. oracle_identity_show
     → see your saved identity + Oracle's persona (skip if not set up yet)

2. oracle_skills
     → list available skills (review, debug, security, ...) before consulting

3. oracle_oracle_list
     → see registered oracle profiles (skill+model+provider+memory bundles)

4. oracle_memory_list { agent: "<your-name>", limit: 5 }
     → surface recent facts/insights before starting work, if memory is relevant
```

If identity has never been set up, call `oracle_identity_setup` once with
name/role/preferences — every `oracle_consult` call after that auto-injects
this context into the system prompt (see `server.ts:88-89`), no need to
repeat it.

## 2. Consult loop

```
oracle_consult { prompt, skill?, files?, previousSessionId? }
   │
   ├─ resolves skill → composes system prompt template
   ├─ auto-injects identity context (if set)
   ├─ if the oracle profile used has memory=true: auto-injects prior
   │  memory entries for that oracle name
   ├─ sends prompt + bundled files to the configured provider
   └─ persists a session record (oracle_sessions / oracle_session_get)
```

After a consult that produced a durable insight, and the oracle profile has
`memory: true`, the server already writes it back automatically — you don't
need to call a separate remember step for consult results. Use
`oracle_memory_list` / `oracle_memory_clear` only when you need to inspect
or reset that store directly (e.g. between unrelated tasks).

## 3. Peer mesh (agent-to-agent messages)

Use when coordinating with another agent (human-run Codex session, another
Claude instance, etc.) sharing this workspace's `.oracle/messages/` store.

| Tool | Purpose |
|---|---|
| `oracle_peer_send` | Send to one recipient (`to`, `body`, `from`, `kind`, `subject?`, `parentId?`) |
| `oracle_peer_broadcast` | Send to `*` (all agents) |
| `oracle_peer_list` | List messages, filter by `agent`/`kind`/`limit` |
| `oracle_peer_unread` | Get unread messages for `agent`, optionally `sinceId` |
| `oracle_peer_thread` | Get all messages in a thread by `rootId` |

Message kinds that expect a reply: `question`, `review-request`, `proposal`.
Reply by sending a new message with `parentId` set to the original message's
`id` (returned from `oracle_peer_send`/`oracle_peer_list`) — this repo's
mesh has no dedicated `reply_to_message` tool, so thread linkage is manual.

There is no `wait_for_message`/blocking poll tool here — check
`oracle_peer_unread` at natural checkpoints instead of polling in a tight
loop.

## 4. Full flow, all four pieces combined

```
SESSION START
  ├─► oracle_identity_show                         (context about you)
  ├─► oracle_memory_list(agent=me, limit=5)         (recent knowledge)
  └─► oracle_peer_unread(agent=me)                  (anything waiting)

WORK
  ├─► oracle_skills → pick skill
  ├─► oracle_consult(prompt, skill, files)          (auto: identity + memory)
  ├─► if result needs to reach another agent:
  │     oracle_peer_send(to, body, kind, parentId?)
  └─► oracle_sessions / oracle_session_get           (recall past work)

MAINTENANCE (occasional, not every turn)
  ├─► oracle_memory_clear(agent=me)                 (before a fresh task)
  └─► oracle_oracle_register(name, skill, memory)   (save a reusable preset)
```

## 5. Reference — full tool list

| Category | Tools |
|---|---|
| Consult | `oracle_consult`, `oracle_skills`, `oracle_sessions`, `oracle_session_get` |
| Oracle profiles | `oracle_oracle_list`, `oracle_oracle_register` |
| Memory | `oracle_memory_list`, `oracle_memory_clear` |
| Identity | `oracle_identity_show`, `oracle_identity_setup`, `oracle_persona_set` |
| Peer mesh | `oracle_peer_send`, `oracle_peer_broadcast`, `oracle_peer_list`, `oracle_peer_unread`, `oracle_peer_thread` |
| Diagnostics | `oracle_doctor` |

On-disk stores: `.oracle-memory/{facts,insights,chunks,working}/` and
`.oracle/messages/<id>.json` — both scoped to the workspace root the MCP
server was started against (`ORACLE_WORKSPACE_ROOT` or `cwd`).

## Red flags — you're breaking the flow

| Thought | Reality |
|---|---|
| "I'll skip oracle_identity_show, I remember the user" | Your context resets between sessions; the profile store doesn't |
| "I'll call oracle_memory_clear after every consult" | Wipes working memory needed later in the same task — only clear at real checkpoints |
| "I'll use send_message / wait_for_message" | Those don't exist here — this repo's tools are `oracle_peer_*`, not the external oracle-messages tool names |
| "No reply tool, so I'll just send a fresh message" | Set `parentId` to the original message id or the thread breaks for other agents reading `oracle_peer_thread` |
