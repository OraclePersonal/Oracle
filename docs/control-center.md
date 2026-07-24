# Oracle Control Center 0.3.0

Control Center is Oracle's local human control plane. It visualizes the
existing TaskStore, project/global memory, and immutable audit log, and adds a
persistent approval inbox to Runtime SQLite.

It is deliberately local-first. The dashboard and API bind to loopback, use
the owner-only Runtime token, and do not require a hosted service.

## Start

```bash
cd /path/to/project
oracle daemon start
```

The project directory at daemon startup becomes Control Center's fixed
workspace. Restart Runtime from a different project when you want to inspect a
different workspace.

## Terminal UI

```bash
oracle control
```

The dependency-free interactive TUI refreshes Runtime data and supports:

- `j` / `k` or arrow keys — select an approval
- `a` — approve
- `x` — reject
- `r` — refresh immediately
- `q` — quit

Use `--actor <name>` to record the decision identity. In scripts and
non-interactive terminals, use a one-shot snapshot:

```bash
oracle control --once
oracle control snapshot
```

## Web dashboard

```bash
oracle control url
```

Open the printed loopback URL. Its credential is carried in the URL fragment,
stored for the current browser tab, then removed from the address bar. The
responsive blue dashboard shows:

- pending approval count and risk distribution
- task status lanes and recently updated tasks
- project/global memory totals and type distribution
- policy denials and recent audit events
- live updates from the Runtime WebSocket

Do not share the printed URL. It contains the local Runtime credential.

## Approval inbox

Task submissions entering `review` become approval requests automatically.
Approving or rejecting them calls the existing `CoordinationService`, so the
TaskStore transition and linked task message use the same durable flow as
`oracle task close`.

Custom requests can be created explicitly:

```bash
oracle approval request \
  --title "Deploy release" \
  --description "Release 0.3.0 passed verification" \
  --requested-by builder \
  --assigned-to lead \
  --kind command \
  --risk high

oracle approval list
oracle approval show <approval-id>
oracle approval approve <approval-id> --by lead --note "verified"
oracle approval reject <approval-id> --by lead --note "needs rollback plan"
```

Command and policy approvals record a decision; they never execute the
referenced command or policy action automatically.

Approval decisions are persisted in `~/.oracle/runtime/oracle.db` and appended
to `<workspace>/.oracle/audit.jsonl`.

## Optional Telegram notifications

Telegram is an optional notification channel, not a dependency or a remote
decision authority:

```bash
export ORACLE_TELEGRAM_BOT_TOKEN="..."
export ORACLE_TELEGRAM_CHAT_ID="..."
oracle daemon start
```

When both variables are set, new approvals are sent to that chat with the
approval id and local CLI command. If either is absent, Telegram remains
disabled. Notification failure does not block the local request and is emitted
as `approval.notification.failed`.

Decisions stay in the authenticated local Dashboard, TUI, or CLI. Bot tokens
are never written to Runtime state, SQLite approval records, audit logs, or
events.

## Local API

All routes require the Runtime token:

```text
GET  /v1/control/snapshot
GET  /v1/control/approvals?status=pending
POST /v1/control/approvals
GET  /v1/control/approvals/:id
POST /v1/control/approvals/:id/decision
```

Related WebSocket events:

- `approval.requested`
- `approval.approved`
- `approval.rejected`
- `approval.notification.failed`

---
*Oracle — A persistent coordination layer for AI coding agents*
*https://github.com/OraclePersonal/Oracle*
