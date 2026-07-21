---
name: oracle-messaging
description: Relays messages between agents over Oracle's file-backed inter-agent bus (shared ~/.oracle/messages), with broadcasts, threading, per-agent read state, and real-time or on-idle wake-up. Use when coordinating multiple agents — sending, receiving, or waiting on messages between Claude Code sessions, opencode, or any oracle-mcp client on the same machine, via the oracle_msg_* MCP tools or the `oracle msg` CLI.
---

# Oracle Inter-Agent Messaging

Oracle is the relay between agents on this machine. Every oracle-mcp process
and every `oracle msg` CLI call shares one file-backed bus at
`~/.oracle/messages/` (override root with `ORACLE_HOME_DIR`), so a message
written by any session is instantly visible to all others. No server, no
network — just atomic JSON files.

## Core concepts

- **Agent name** — free-form string identifying each participant (e.g.
  `claude-main`, `codex-worker`). Pick one per session and stay consistent;
  it is your inbox address and your `readBy` identity. There is no registry —
  names exist by being used.
- **Message** — `{ id, ts, from, to, subject?, body, replyTo?, readBy[] }`.
- **Broadcast** — `to: "*"` reaches every agent except the sender.
- **Read state is per-agent** — acking as `codex` doesn't mark it read for
  `gemini`. Broadcasts stay "unread" for each agent until *they* ack.
- **Threads** — set `replyTo: <id>` when answering; `oracle_msg_thread`
  reconstructs the whole conversation from any message in it.

## Tool surface

| MCP tool | CLI | Purpose |
|---|---|---|
| `oracle_msg_send` | `oracle msg send -f me -t peer -b "..." [-s subj] [--reply-to id] [--ack] [--body-file f \| -b -]` | Send / broadcast / reply. `--ack` also acks the replied-to id (reply+ack in one command). Long/multiline bodies: `--body-file` or stdin via `-b -` |
| `oracle_msg_inbox` | `oracle msg inbox -a me [--all] [--limit n] [--json] [--wait --timeout s]` | Read unread (default). `--json` for scripting (empty inbox = `[]`). `--wait` blocks until a message arrives — no hand-rolled poll loops |
| `oracle_msg_ack` | `oracle msg ack -a me <ids...> \| --all` | Mark handled; `--all` clears every unread |
| `oracle_msg_thread` | — | Full conversation for an id |
| — | `oracle msg status <id>` | One message + who has read it (sender-side read receipt) |
| — | `oracle msg watch -a me [--exec "cmd"]` | Real-time push (see below) |

MCP tools appear after `oracle setup-mcp --client claude-code` wires the
server; the CLI works from any shell with the repo built (`npm run build`,
then `node dist/cli.js msg ...` or a linked `oracle` bin).

## The collaboration loop (follow this as an agent)

```
1. On session start / task start:
     oracle_msg_inbox { agent: "<me>" }        ← anything waiting for me?

2. Handle each message:
     - do the work it asks, or answer the question
     - reply with oracle_msg_send { replyTo: <its id> }  ← keep threads intact
     - oracle_msg_ack { agent: "<me>", ids: [...] }      ← ALWAYS ack after handling

3. Need something from another agent:
     oracle_msg_send { from: "<me>", to: "<peer>", subject: "<short verb phrase>", body: "<request + context>" }
     → keep working on other things; check inbox again at natural pauses
       (after finishing a subtask, before declaring done)

4. Waiting on a reply and out of other work:
     CLI:  oracle msg inbox -a <me> --wait --timeout 120   ← blocks, no poll loop
     MCP:  exit the turn and let the Stop hook / watcher wake you.
```

**Scripting tips (learned from live two-agent runs):**
- Parse `--json`, not prose — empty inbox prints `Inbox empty.` in human mode
  but `[]` in JSON mode; grepping prose is how loops break.
- Reply and ack in one step: `msg send --reply-to <id> --ack`.
- Done with everything? `msg ack -a <me> --all`.
- Review-sized payloads: write to a file and `--body-file` it (or `-b -` with
  stdin) — quoting a multiline body on the command line is fragile.
- `msg status <id>` shows `readBy` — the sender's read receipt.

**Rules that keep the bus healthy:**
- Ack everything you've read and handled — unacked messages re-trigger the
  Stop hook and clutter every future inbox check.
- Always thread replies (`replyTo`), never start a parallel message for the
  same topic.
- Put the request in `body` with enough context to act on it — the peer does
  not share your conversation, only the message text.
- One topic per message; broadcasts only for things every agent cares about
  (build broke, lock released, shutting down).

## Wake-up mechanics (how idle agents learn about messages)

Three layers, weakest to strongest:

1. **Pull** — agents check `oracle_msg_inbox` at task boundaries. Zero setup.
2. **Push-on-idle (Stop hook)** — when Claude finishes a turn, the hook
   blocks the stop if unread messages exist, so the agent reads/acks before
   idling. Register in `.claude/settings.json`:

   ```json
   {
     "hooks": {
       "Stop": [{ "hooks": [{ "type": "command",
         "command": "node <ORACLE_REPO>/scripts/oracle-msg-stop-hook.mjs <my-agent-name>" }] }]
     }
   }
   ```

   Loop-safe: it passes `stop_hook_active` through, fails open on any error,
   and is a no-op without an agent name.
3. **Real-time push (watcher)** — a separate process fires the moment a
   message lands; `--exec` runs per message with `ORACLE_MSG_ID/FROM/TO/
   SUBJECT/BODY` env vars. Point it at whatever wakes the live session,
   e.g. tmux:

   ```bash
   # POSIX ($VAR); on Windows --exec runs under cmd.exe → use %VAR%
   oracle msg watch -a codex \
     --exec 'tmux send-keys -t claude-pane "Oracle msg from $ORACLE_MSG_FROM — check oracle_msg_inbox" Enter'
   ```

## Setup checklist (once per machine)

```bash
cd <ORACLE_REPO>
npm install && npm run build      # build dist/cli.js + dist/mcp.js
oracle setup-mcp --client claude-code   # register MCP server (per workspace)
# optional: Stop hook (per agent) and/or msg watch (per live pane) as above
```

Store location: `~/.oracle/messages/*.json` — safe to inspect or delete old
messages by hand; each file is one message, writes are atomic (tmp+rename).

## Known limitations (from a live concurrency review — accepted for now)

- **Concurrent acks can lose one ack**: `ack` is read-modify-write without a
  lock; two agents acking the same broadcast at the same instant may drop one
  `readBy` entry. Consequence: a Stop hook may re-fire once. Harmless but
  real; re-ack if you see a message twice.
- **Windows rename contention**: simultaneous ack + inbox on the same file
  can throw EPERM under heavy concurrency; retry succeeds.
- **The store grows forever**: every inbox call reads all files. Fine for
  thousands of messages; delete old files by hand if the dir gets huge.

## Worked example (two sessions)

Session A (`lead`):
```
oracle_msg_send { from: "lead", to: "worker", subject: "review request",
  body: "Review src/messaging/store.ts for concurrency issues. Reply with findings." }
```

Session B (`worker`) — woken by hook/watcher or checking at task start:
```
oracle_msg_inbox { agent: "worker" }          → sees the request (id M1)
...does the review...
oracle_msg_send { from: "worker", to: "lead", replyTo: "M1",
  body: "2 findings: (1) ... (2) ..." }
oracle_msg_ack { agent: "worker", ids: ["M1"] }
```

Session A: inbox → reads findings (id M2) → `oracle_msg_thread { id: M2 }`
shows the whole exchange → ack M2 → done.
