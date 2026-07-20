# Oracle Dashboard

A local web dashboard that visualizes the on-disk state of the Oracle memory and messaging systems.

## What it does

Oracle Dashboard is a small Express server that serves a static web frontend and exposes HTTP API routes which read stats from sibling Oracle projects on disk. The `memory` route counts files in the `Oracle-memory/.oracle-memory` directory (facts, insights, chunks, working), and the `messages` route lists JSON files in `Oracle-messages/.oracle/messages`. The `status` route reports server health, uptime, and version. It does not modify any data; it only reads and aggregates counts.

## Install / Build

```bash
npm install
npm run build      # compile TypeScript to dist/ (tsc)
```

## Run

```bash
npm start          # run compiled server: node dist/index.js
npm run dev        # run directly with tsx: tsx src/index.ts
```

The server starts on port `3456` by default (override with the `PORT` environment variable) and serves the dashboard at `http://localhost:3456`.

## API routes

All routes are read-only JSON endpoints mounted under `/api`:

- `GET /api/memory` — counts of memory files (facts, insights, chunks, working) and whether the memory directory exists.
- `GET /api/messages` — message file stats: total files, JSON file count, and the 10 most recent message filenames.
- `GET /api/status` — server status, uptime (seconds), server name, version, and timestamp.
- `GET /api/status/peers` — returns an empty peer list (`[]`).

The root path serves the static frontend from `public/`.

## Configuration

- `PORT` — TCP port for the server (default `3456`).

The dashboard expects two sibling directories relative to the project root (parent of `Oracle-dashboard`):

- `../Oracle-memory/.oracle-memory` — memory store (facts, insights, chunks, working subdirs)
- `../Oracle-messages/.oracle/messages` — message store (`.json` files)

If a directory is missing, its stats report `exists: false` rather than failing.
