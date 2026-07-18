#!/usr/bin/env node
import path from "node:path";
import { runHttp, runStdio } from "./server.js";

const HELP = `oracle-messages 0.2.0 — Universal MCP mailbox for AI coding agents

A vendor-neutral message bus that any MCP-compatible agent can use:
Claude Code, Codex / Gemini CLI, Cline, OpenCode, KilloCode, Clew Code, and more.

USAGE
  oracle-messages [options]

OPTIONS
  --http              Run in HTTP/Streamable HTTP mode (default: stdio)
  --port <number>     HTTP port (default: 8770, env: ORACLE_MESSAGES_PORT)
  --host <address>    HTTP bind address (default: 127.0.0.1, env: ORACLE_MESSAGES_HOST)
  --dir <path>        Data directory (default: .oracle-messages, env: ORACLE_MESSAGES_DIR)
  --help              Show this message
  --version           Show version

ENVIRONMENT
  ORACLE_MESSAGES_DIR        Data directory for JSONL message store
  ORACLE_MESSAGES_TRANSPORT  "stdio" (default) or "http" or "streamable"
  ORACLE_MESSAGES_PORT       HTTP port (default: 8770)
  ORACLE_MESSAGES_HOST       HTTP bind address (default: 127.0.0.1)
  ORACLE_MESSAGES_HTTP_TOKEN Bearer token for HTTP authorization

TOOLS (30+)
  Identity:    onboard, register_identity, get_status, get_agent_instructions
  Roster:      list_agents, add_agent, retire_agent, set_agent_role, set_agent_group
  Messaging:   send_message, broadcast, wait_for_message, sync_messages,
               list_messages, search_messages, get_message, reply_message,
               get_thread, list_open_threads, delete_message
  Acks:        acknowledge_message, get_acknowledgements
  Cursors:     advance_cursor
  Tasks:       create_task, transition_task, get_task, list_tasks
  Discovery:   set_agent_card, get_agent_card, find_agents
  Channels:    subscribe, unsubscribe
  Server:      mailbox_stats, prune

RESOURCES
  oracle://instructions   oracle://roster     oracle://messages
  oracle://threads/open   oracle://stats      oracle://agent/{name}/unread
  oracle://message/{id}   oracle://thread/{id}

PROMPTS
  standup, triage_unread, handoff, review_request
`;

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}
if (args.includes("--version")) {
  console.log("0.2.0");
  process.exit(0);
}

const rootDir = path.resolve(process.env.ORACLE_MESSAGES_DIR ?? ".oracle-messages");

// --http / --port / --host flags override env
const transportFlag = args.includes("--http") ? "http" : null;
const transport = transportFlag ?? (process.env.ORACLE_MESSAGES_TRANSPORT ?? "stdio").toLowerCase();

if (transport === "http" || transport === "streamable") {
  const portFlag = args.indexOf("--port");
  const port = portFlag >= 0
    ? Number.parseInt(args[portFlag + 1], 10)
    : Number.parseInt(process.env.ORACLE_MESSAGES_PORT ?? "8770", 10);
  const hostFlag = args.indexOf("--host");
  const host = hostFlag >= 0
    ? args[hostFlag + 1]
    : (process.env.ORACLE_MESSAGES_HOST ?? "127.0.0.1");
  const dirFlag = args.indexOf("--dir");
  const dir = dirFlag >= 0 ? path.resolve(args[dirFlag + 1]) : rootDir;
  await runHttp(dir, port, host);
} else {
  const dirFlag = args.indexOf("--dir");
  const dir = dirFlag >= 0 ? path.resolve(args[dirFlag + 1]) : rootDir;
  await runStdio(dir);
}
