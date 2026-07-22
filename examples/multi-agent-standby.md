# Example: A Real Multi-Agent Team (Standby Workers + Push Wake-up)

This is the exact workflow verified live on 2026-07-22: one **lead** session
assigning real work, and **worker** sessions that sit waiting and wake up the
moment work arrives — no "go check your inbox" nudging, ever.

Two kinds of workers, pick per session:

| Worker style | Wake mechanism | Setup needed |
|---|---|---|
| **Standby worker** (plain Claude Code window) | `oracle_msg_inbox { wait: true }` blocking loop | none — just a prompt |
| **tmux worker** (detached, background) | external watcher types into its pane | one launcher command (WSL) |

---

## 1. The lead session

Any Claude Code session with the Oracle MCP connected. Register once:

```
Register on the oracle bus as "lead" and check who's online.
```

That's it. The lead assigns work with `oracle_task_create` and reviews with
`oracle_task_get` / `oracle_task_close`.

---

## 2. A standby worker (zero config — the easy one)

Open a normal Claude Code window in the repo and give it ONE prompt:

```
Register on the oracle bus as "worker-1" (role: general worker).
Then enter standby mode: loop oracle_msg_inbox { agent: "worker-1",
wait: true, timeoutSeconds: 600 } until work arrives. When you get a
message or task: do the work, update the task as you go, submit it,
then RETURN to standby. Only stop when I tell you to.
```

What happens under the hood:

- `wait: true` **blocks inside the tool call** (1.5s poll) until an unread
  message lands, so the worker reacts within ~2 seconds of being messaged.
- On `waitTimedOut: true` (nothing arrived in `timeoutSeconds`) the worker
  immediately re-arms — the server instructions teach this loop, so it
  won't drift out of the conversation.
- After finishing a task it re-enters the loop (also in the server
  instructions), so one prompt buys you a permanent worker.

Trade-off: while waiting it can't do other work — it's parked in the call.

---

## 3. A tmux worker (wakes even from full idle, survives with no prompt)

Inside WSL (needs tmux; Claude runs as the Windows `claude.exe` via interop,
reusing your Windows login):

```bash
./scripts/oracle-tmux-launch.sh worker-2
```

This opens a tmux session `oracle-worker-2` with two panes:
- pane 0 — a real Claude Code session
- pane 1 — `oracle-tmux-push-watcher.mjs`, which watches the shared message
  store and **types a nudge into pane 0** the instant a message for
  `worker-2` lands

First time only: attach and register it —

```bash
# from Windows:
wt.exe wsl -d Ubuntu -- tmux attach -t oracle-worker-2
# in the Claude pane, say once:
#   register with oracle as "worker-2", then stand by
# detach with Ctrl-b then d  (do NOT close the window with X / exit)
```

From then on it wakes itself — even when completely idle at the prompt.

---

## 4. Assign real work (from the lead)

```
Create an oracle task: title "Add unit tests for the health endpoint",
assign to worker-1, checklist:
- write the tests
- npx vitest run passes
- npm run typecheck passes
Description: <what and where, exact commands to verify>.
```

`oracle_task_create` automatically messages the assignee → the standby
worker's `wait` call unblocks (or the watcher wakes the tmux worker) → it
works the task for real:

1. `oracle_task_update` → `in_progress` + progress notes as it goes
2. `oracle_task_checklist` → ticks items **as they're actually done**
3. `oracle_task_submit` → **blocked unless every item is ticked**; on
   success the lead is auto-messaged
4. lead verifies (run the tests yourself!) → `oracle_task_close`
   `approved: true`, or `approved: false` + note to bounce it back
5. worker returns to standby for the next assignment

Real result from the live run: worker woke **23s** after task creation,
wrote 62 lines of tests, ran the suite (11/11) + typecheck itself, and
submitted — total 1m46s, zero human nudges.

---

## 5. Talk to a worker directly (no task, just a message)

```
Send an oracle message to worker-1: "Before you continue, switch the
test file to use unique agent names per test."
```

Standby workers see it within seconds; reply threads use `replyTo`.

## Troubleshooting

- **Worker doesn't wake** → is it actually in the wait loop (standby) or
  behind a watcher (tmux)? A plain idle window with neither will never
  wake — that's expected. Nudge it once or relaunch it in one of the two
  modes.
- **`wait` param rejected** → that session's MCP server predates the
  feature; restart the Claude Code window so it reconnects to the new
  build.
- **tmux worker: watcher logs the push but Claude doesn't react** → you
  attached and left the pane in copy-mode/scrollback; press `q` in pane 0.
- **Windows + WSL sharing one bus** → point everything at the same store:
  from WSL use `--home /mnt/c/Users/<you>/.oracle` (the launcher does this
  by default via `ORACLE_HOME_DIR`).

## See also

- `MESSAGING.md` — the four wake-up tiers and when to use which
- `scripts/oracle-tmux-launch.sh` / `scripts/oracle-tmux-push-watcher.mjs`
- `examples/workflow-dashboard.mjs` — scripted (non-interactive) version of
  the same coordination flow
