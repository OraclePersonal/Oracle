#!/usr/bin/env node
import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MessageStore } from "./messaging/store.js";
import { AgentRegistry } from "./messaging/registry.js";
import { registerMessagingTools, MESSAGING_INSTRUCTIONS } from "./mcp/messagingTools.js";
import { VERSION } from "./version.js";

/**
 * Standalone inter-agent messaging MCP server: exposes only the
 * `oracle_msg_*` tools over the shared ~/.oracle/messages bus, with none of
 * Oracle's provider/memory/agent stack. Wire this into any MCP client that
 * just needs agents to talk to each other.
 *
 *   npx -p @oraclepersonal/oracle oracle-msg-mcp
 *
 * Store location follows ORACLE_HOME_DIR (default ~/.oracle), so it shares
 * the exact same bus as the full oracle-mcp server and the `oracle msg` CLI.
 */
const homeDir = process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle");
const server = new McpServer(
  { name: "oracle-messaging", version: VERSION },
  { instructions: MESSAGING_INSTRUCTIONS }
);
registerMessagingTools(server, new MessageStore(homeDir), new AgentRegistry(homeDir));
await server.connect(new StdioServerTransport());
