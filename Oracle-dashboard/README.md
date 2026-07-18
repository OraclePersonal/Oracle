# Oracle Dashboard

> See the swarm at a glance. Memory stats, message activity, agent status.

Live web dashboard for the Oracle ecosystem — memory counts, message bus activity,
and peer/agent status in one dark-themed UI.

## Quick start

```bash
npm install
npm run dev        # http://localhost:3456
```

## API

| Route | Description |
|-------|-------------|
| `/api/status` | Server health + uptime |
| `/api/memory` | `.oracle-memory/` counts |
| `/api/messages` | `.oracle/messages/` stats |
| `/api/status/peers` | Discovered peer agents |

## Layout

```
public/
├── index.html   # Dashboard page
└── style.css    # Dark theme
src/
├── index.ts     # Express server
└── api/
    ├── status.ts
    ├── memory.ts
    └── messages.ts
```

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Start dev server (tsx) |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled |

## Related

- [Oracle](https://github.com/JonusNattapong/Oracle) — CLI for AI code consulting
- [Oracle-memory](https://github.com/JonusNattapong/Oracle-memory) — File-backed MCP memory server
- [Oracle-messages](https://github.com/JonusNattapong/Oracle-messages) — MCP message bus
- [Oracle-templates](https://github.com/JonusNattapong/Oracle-templates) — Template system
