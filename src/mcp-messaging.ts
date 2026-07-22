#!/usr/bin/env node
import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MessageStore } from "./messaging/store.js";
import { AgentRegistry } from "./messaging/registry.js";
import { TaskStore } from "./tasks/store.js";
import { registerMessagingTools, MESSAGING_INSTRUCTIONS } from "./mcp/messagingTools.js";
import { registerTaskTools, TASK_INSTRUCTIONS } from "./mcp/taskTools.js";
import { VERSION } from "./version.js";

/**
 * Standalone coordination MCP server: exposes the `oracle_msg_*` messaging
 * tools and `oracle_task_*` planning/tracking tools over the shared
 * ~/.oracle store, with none of Oracle's provider/memory/agent stack. Wire
 * this into any MCP client that just needs agents to talk and coordinate.
 *
 *   npx -p @oraclepersonal/oracle oracle-msg-mcp
 *
 * Store location follows ORACLE_HOME_DIR (default ~/.oracle), so it shares
 * the exact same bus as the full oracle-mcp server and the `oracle msg`/
 * `oracle task` CLI commands.
 */
const homeDir = process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle");
const server = new McpServer(
  { name: "oracle-messaging", version: VERSION },
  { instructions: `${MESSAGING_INSTRUCTIONS} ${TASK_INSTRUCTIONS}` }
);
const messages = new MessageStore(homeDir);
const registry = new AgentRegistry(homeDir);
registerMessagingTools(server, messages, registry);
registerTaskTools(server, new TaskStore(homeDir), messages, registry);
await server.connect(new StdioServerTransport());
