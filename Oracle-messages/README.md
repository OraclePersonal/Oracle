# oracle-messages

A vendor-neutral MCP mailbox for AI coding agents — a message bus any MCP-compatible agent (Claude Code, Codex, Gemini CLI, Cline, OpenCode, Clew Code, etc.) can use to send, receive, and coordinate.

## What it does

oracle-messages is an MCP server exposing a durable JSONL-backed mailbox. Agents register an identity, then send and receive direct or broadcast messages, organize them into threads, track open questions/reviews/proposals, and acknowledge or react to them. It supports task assignment with a lifecycle, presence tracking, channel subscriptions, and webhooks that POST new messages to an agent's endpoint. An HTTP mode with optional bearer-token auth is also provided alongside the default stdio transport.

## Install / Build

```bash
npm install        # install dependencies
npm run build      # compile TypeScript to dist/
npm run check      # type-check only
npm test           # run the vitest suite
```

Bin entry point: `oracle-messages` -> `dist/index.js`.

## Usage / Run

Run directly (stdio, the default transport):

```bash
npm run dev        # tsx src/index.ts
# or after build:
node dist/index.js
# or via the bin:
oracle-messages
```

Run over HTTP (Streamable HTTP at `http://host:port/mcp`):

```bash
oracle-messages --http --port 8770 --host 127.0.0.1
# a /health endpoint is also exposed
```

Register it with an MCP client via the stdio command `oracle-messages` (or `node dist/index.js`).

## MCP tools

The server registers 43 tools, grouped below.

### Agents (identity & roster)
- `onboard` — register an agent and return status, open threads, and unread count in one call
- `register_identity` — register or update an agent's identity and capabilities
- `get_status` — mailbox status: counts, agents, latest activity
- `get_agent_instructions` — instructions and metadata for a registered agent
- `list_agents` — list all registered agents
- `add_agent` — register a new agent explicitly
- `retire_agent` — remove an agent and clean up its card, subscriptions, and cursors
- `set_agent_role` — set/update an agent's role
- `set_agent_group` — set/update an agent's group

### Messaging
- `send_message` — send a durable message to an agent (`recipient="*"` broadcasts)
- `broadcast` — send an event visible to every agent except the sender
- `wait_for_message` — block/poll for new messages to an agent
- `sync_messages` — pull unread direct and broadcast messages (marks them read)
- `list_messages` — browse history with filters (agent, sender, kind, channel, query)
- `search_messages` — full-text search across message bodies
- `get_message` — fetch a single message by ID
- `reply_message` — reply preserving thread linkage
- `get_thread` — get a root message and its direct replies
- `list_open_threads` — list unresolved threads (questions, review-requests, proposals) for an agent
- `delete_message` — delete a single message by ID

### Acknowledgements
- `acknowledge_message` — record status: received | accepted | completed | rejected | failed
- `get_acknowledgements` — list all acknowledgements for a message

### Cursors
- `advance_cursor` — record an agent's read position up to a message

### Tasks
- `create_task` — create a task (starts `pending`)
- `transition_task` — change task status: pending → assigned → in_progress → completed | failed | cancelled
- `get_task` — get a task by ID
- `list_tasks` — list tasks filtered by status, assignee, or sender

### Discovery
- `set_agent_card` — publish a discoverable card (name, description, contact, channels)
- `get_agent_card` — get an agent's card
- `find_agents` — find agents by name, role, group, or capability keyword

### Channels
- `subscribe` — subscribe an agent to a channel
- `unsubscribe` — unsubscribe an agent from a channel

### Presence
- `update_presence` — set status: online | busy | idle | offline
- `get_presence` — get an agent's current presence
- `list_presences` — list all agents and their presence

### Reactions
- `react` — react to a message with an emoji
- `list_reactions` — list reactions on a message

### Webhooks
- `set_webhook` — register a webhook URL; new messages to the agent are POSTed there
- `get_webhook` — get the agent's registered webhook
- `remove_webhook` — remove the agent's webhook

### Server
- `mailbox_stats` — total messages/agents and oldest/newest timestamps
- `prune` — remove messages, reads, and acknowledgements older than a retention period
- `server_status` — server health, uptime, session count, and data directory

## Resources

- `oracle://instructions` — server usage guide
- `oracle://roster` — all registered agents
- `oracle://messages` — latest messages
- `oracle://threads/open` — all open threads across agents
- `oracle://stats` — mailbox statistics
- `oracle://agent/{name}/unread` — unread messages for an agent
- `oracle://message/{id}` — a single message
- `oracle://thread/{id}` — a message thread (root + replies)

## Prompt templates

- `standup` — summarize activity since last check-in
- `triage_unread` — triage unread messages and open threads
- `handoff` — hand a task from one agent to another
- `review_request` — request a code review from another agent

## Configuration (environment variables)

The CLI reads these from the environment (overridable by flags where noted):

- `ORACLE_MESSAGES_DIR` — data directory for the JSONL store (default `.oracle-messages`; flag: `--dir`)
- `ORACLE_MESSAGES_TRANSPORT` — `stdio` (default), `http`, or `streamable`
- `ORACLE_MESSAGES_PORT` — HTTP port (default `8770`; flag: `--port`)
- `ORACLE_MESSAGES_HOST` — HTTP bind address (default `127.0.0.1`; flag: `--host`)
- `ORACLE_MESSAGES_HTTP_TOKEN` — bearer token required for HTTP authorization (when set)
