# Oracle Messages

> The group chat your AI agents never leave. No server, no polling — just JSON files and a durable mailbox.

Multi-agent MCP message bus for AI coding agents. Send, receive, and coordinate
across agents — all backed by atomic JSONL files. No database, no daemon.

## Quick start

```bash
npm install && npm run build
npm start              # stdio MCP server (default)
```

Wire it into Claude Code:

```bash
claude mcp add oracle-messages -- node /path/to/oracle-messages/dist/index.js
```

## Tools (43)

| Tool | What it does |
|------|--------------|
| `onboard` / `register_identity` | Join the bus |
| `send_message` / `reply_message` / `broadcast` | Send + thread |
| `sync_messages` / `wait_for_message` | Receive |
| `search_messages` / `list_messages` / `get_message` | Browse |
| `get_thread` / `list_open_threads` | Threads |
| `update_presence` / `get_presence` / `list_presences` | Who's online |
| `react` / `list_reactions` | Emoji reactions |
| `set_webhook` / `get_webhook` / `remove_webhook` | Push notifications |
| `create_task` / `transition_task` / `list_tasks` / `get_task` | Task lifecycle |
| `subscribe` / `unsubscribe` | Channels |
| `retire_agent` / `set_agent_role` / `set_agent_group` | Agent management |
| `set_agent_card` / `get_agent_card` / `find_agents` | Discovery |
| `acknowledge_message` / `get_acknowledgements` | Confirm receipt |
| `advance_cursor` / `mailbox_stats` / `prune` | Maintenance |

Plus 5 resources, 4 built-in prompts.

## Layout

```
.oracle-messages/
├── agents.jsonl        # Registered agents
├── messages.jsonl      # All messages
├── reads.jsonl         # Read tracking
├── acknowledgements.jsonl
├── subscriptions.jsonl
├── presences.jsonl
├── reactions.jsonl
├── webhooks.jsonl
├── cursors.jsonl
├── cards.jsonl
└── sessions.jsonl
```

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | Compile TypeScript |
| `npm run check` | Type-check only |
| `npm run dev` | Run via tsx |
| `npm start` | Run compiled |
| `npm test` | Run tests |

## Related

- [Oracle](https://github.com/JonusNattapong/Oracle) — CLI for AI code consulting
- [Oracle-memory](https://github.com/JonusNattapong/Oracle-memory) — File-backed MCP memory server
- [Oracle-skill](https://github.com/JonusNattapong/Oracle-skill) — Cross-agent workflow docs
- [Oracle-templates](https://github.com/JonusNattapong/Oracle-templates) — Template system
