#!/usr/bin/env node
console.log = console.error;
import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOracleMcpServer } from "./mcp/runtime.js";

const server = await createOracleMcpServer();
await server.connect(new StdioServerTransport());

