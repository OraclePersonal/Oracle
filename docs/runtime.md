# Oracle Runtime 0.2.0

Oracle Runtime is a persistent local service that owns long-lived scheduling,
SQLite state, a loopback HTTP API, and a WebSocket event stream.

## Start and inspect

```bash
oracle daemon start
oracle daemon status
oracle daemon events
oracle daemon stop

# Foreground mode for development or process supervisors
oracle daemon run
```

The default endpoint is `http://127.0.0.1:4777`. Pass `--port 0` to allocate
an available port. The daemon writes state to
`~/.oracle/runtime/daemon.json`, logs to `~/.oracle/runtime/daemon.log`, and
SQLite data to `~/.oracle/runtime/oracle.db`.

`oracle schedule watch` remains as a foreground alias for
`oracle daemon run`. Other `oracle schedule` commands automatically use the
daemon API while it is available and fall back to the same SQLite database
when the daemon is stopped.

## Scheduler service

```bash
oracle schedule add "tests" "*/5 * * * *" "npm test"
oracle schedule list
oracle schedule update <id> --status paused
oracle schedule update <id> --status active
oracle schedule run <id>
oracle schedule remove <id>
```

At first startup, legacy JSON records from `~/.oracle/scheduler/*.json` are
imported with `INSERT OR IGNORE`. The original files are left untouched, and
repeated startup is idempotent.

The SQLite schema stores current scheduler tasks, run history, runtime
metadata, and replayable events. WAL mode and a busy timeout allow local CLI
readers to coexist with the daemon.

## Local API

Health is available without credentials:

```text
GET /health
```

All `/v1/*` routes require the bearer token kept in the daemon state file:

```text
GET    /v1/schedules
POST   /v1/schedules
GET    /v1/schedules/:id
PATCH  /v1/schedules/:id
DELETE /v1/schedules/:id
POST   /v1/schedules/:id/run
GET    /v1/events?after=<event-id>&limit=<n>
POST   /v1/daemon/stop
```

The CLI reads the token internally. `oracle daemon status --json` deliberately
redacts it.

## WebSocket events

Connect to `/v1/events?token=<token>&after=<event-id>`. The optional `after`
cursor replays persisted SQLite events before live streaming begins.

Event types include:

- `daemon.started`, `daemon.stopping`
- `scheduler.started`, `scheduler.stopped`
- `scheduler.task.created`, `scheduler.task.updated`,
  `scheduler.task.removed`
- `scheduler.run.started`, `scheduler.run.completed`

Use `oracle daemon events --after <id>` instead of handling the token
directly.

## Security boundary

Runtime only accepts `127.0.0.1`, `::1`, or `localhost` as its bind host.
It rejects `0.0.0.0` and external interfaces. The API token and state file
are written with owner-only permissions.

Do not expose Runtime through an SSH tunnel or reverse proxy unless that
proxy adds its own authentication, authorization, and transport security.

## Environment

```text
ORACLE_HOME_DIR       Runtime root (default ~/.oracle)
ORACLE_RUNTIME_HOST   Loopback bind host (default 127.0.0.1)
ORACLE_RUNTIME_PORT   API port (default 4777)
```

---
*Oracle — A persistent coordination layer for AI coding agents*
*https://github.com/OraclePersonal/Oracle*
