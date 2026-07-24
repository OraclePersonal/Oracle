# Scheduled Cron Tasks

The `oracle schedule` command group provides a persistent cron task system — define, list, run, and watch scheduled tasks.

## Data Storage

Tasks are stored as one JSON file per task under `~/.oracle/scheduler/`. Each file contains a `CronTask` record with full metadata including last run time and output.

## CLI Commands

### `oracle schedule list`

List all scheduled tasks with their status, cron expression, and last run result.

```
oracle schedule list
```

### `oracle schedule add <name> <cron> <command>`

Add a new scheduled task.

```
oracle schedule add "daily backup" "0 2 * * *" "pg_dump mydb > /tmp/backup.sql"
oracle schedule add add -d "Run tests every 5 minutes" "*/5 * * * *" "npm test"
```

### `oracle schedule remove <id>`

Remove a scheduled task by its ID (shown in `list` output).

```
oracle schedule remove abc1234-5678-...
```

### `oracle schedule run <id>`

Run a scheduled task immediately (one-shot execution).

```
oracle schedule run abc1234-5678-...
```

Exit code matches the task result: `0` for success, `1` for error.

### `oracle schedule watch`

Start the cron daemon — loads all active tasks from storage and runs them on their cron schedule.

```
oracle schedule watch
```

Runs until interrupted (SIGINT/SIGTERM). Prints task completions to stderr.

```
oracle schedule watch --once
```

Run all active tasks once and exit (for one-shot execution or testing).

## Cron Expressions

Uses standard 5-field cron syntax via [`node-cron`](https://github.com/kelektiv/node-cron):

| Expression | Meaning |
|---|---|
| `* * * * *` | Every minute |
| `*/5 * * * *` | Every 5 minutes |
| `0 * * * *` | Every hour, on the hour |
| `0 2 * * *` | Every day at 2:00 AM |
| `0 0 * * 0` | Every Sunday at midnight |
| `30 14 1 1 *` | January 1st at 2:30 PM |

## Configuration

Tasks are stored under `~/.oracle/scheduler/`. No additional configuration needed.

## Examples

Run a build on every push detected by a file watcher:

```
oracle schedule add "build on change" "* * * * *" "npm run build"
```

Nightly report generation:

```
oracle schedule add "nightly report" "0 6 * * *" "node scripts/report.js"
```

One-off test run:

```
oracle schedule run abc1234...
```

---
*Oracle — A persistent coordination layer for AI coding agents*
*https://github.com/OraclePersonal/Oracle*
