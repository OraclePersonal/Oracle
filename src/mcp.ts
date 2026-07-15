#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { ConsultService } from "./core/consult.js";
import { createProvider, parseProviderName } from "./providers/factory.js";

const workspaceRoot = path.resolve(process.env.ORACLE_WORKSPACE_ROOT ?? process.cwd());
const providerName = parseProviderName(process.env.ORACLE_PROVIDER);
const server = new McpServer({ name: "mini-oracle", version: "0.1.0" });

server.registerTool(
  "consult",
  {
    title: "Consult Oracle",
    description:
      "Bundle a prompt and repository files, call an expert model, and persist the session.",
    inputSchema: {
      prompt: z.string().min(1),
      files: z.array(z.string()).default([]),
      model: z.string().default("gpt-5.4"),
      previousResponseId: z.string().optional()
    }
  },
  async (input) => {
    try {
      const result = await new ConsultService(createProvider(providerName)).consult({
        ...input,
        cwd: workspaceRoot
      });
      return {
        isError: result.status === "error",
        content: [{ type: "text", text: result.output || result.error || "No output" }],
        structuredContent: { ...result }
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) }
        ]
      };
    }
  }
);

await server.connect(new StdioServerTransport());
