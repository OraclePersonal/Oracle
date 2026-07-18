#!/usr/bin/env node
/**
 * oracle-eval — MCP server for evaluating/benchmarking the Oracle multi-agent stack.
 *
 * Provides tools to:
 *   - Benchmark oracle-memory retrieval quality (recall@k, MRR, temporal correctness)
 *   - Benchmark oracle-messages throughput
 *   - Generate SVG bar-chart reports
 *
 * Run:
 *   npm run dev          # stdio MCP server
 *   npm run bench        # run benchmarks and generate SVG report
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const SERVER_NAME = "oracle-eval";
const SERVER_VERSION = "0.1.0";

// ── Schema ─────────────────────────────────────────────────────────────────

const EvalMemorySchema = z.object({
  memoryEndpoint: z.string().optional().describe("oracle-memory endpoint (default: http://localhost:8765)"),
  limit: z.number().optional().default(5).describe("k for recall@k"),
  quick: z.boolean().optional().default(false).describe("skip scale phase"),
});

const EvalMessagesSchema = z.object({
  messagesEndpoint: z.string().optional().describe("oracle-messages endpoint (default: http://localhost:8766)"),
  iterations: z.number().optional().default(50).describe("number of send/poll iterations"),
  payloadSize: z.number().optional().default(256).describe("approximate payload size in bytes"),
});

// ── Server Setup ───────────────────────────────────────────────────────────

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

// ── Tool Handlers ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "eval_memory",
      description: "Benchmark oracle-memory retrieval quality: recall@k, MRR, temporal correctness",
      inputSchema: {
        type: "object",
        properties: {
          memoryEndpoint: {
            type: "string",
            description: "oracle-memory endpoint (default: http://localhost:8765)",
          },
          limit: {
            type: "number",
            description: "k for recall@k (default: 5)",
            default: 5,
          },
          quick: {
            type: "boolean",
            description: "skip scale phase (default: false)",
            default: false,
          },
        },
      },
    },
    {
      name: "eval_messages",
      description: "Benchmark oracle-messages throughput: send/poll latency",
      inputSchema: {
        type: "object",
        properties: {
          messagesEndpoint: {
            type: "string",
            description: "oracle-messages endpoint (default: http://localhost:8766)",
          },
          iterations: {
            type: "number",
            description: "number of send/poll iterations (default: 50)",
            default: 50,
          },
          payloadSize: {
            type: "number",
            description: "approximate payload size in bytes (default: 256)",
            default: 256,
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "eval_memory": {
      const parsed = EvalMemorySchema.parse(args);
      try {
        // Dynamic import so bench modules aren't loaded until needed
        const { runMemoryEval } = await import("./eval/memory.js");
        const result = await runMemoryEval({
          endpoint: parsed.memoryEndpoint ?? "http://localhost:8765",
          k: parsed.limit,
          quick: parsed.quick,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    }

    case "eval_messages": {
      const parsed = EvalMessagesSchema.parse(args);
      try {
        const { runMessagesEval } = await import("./eval/messages.js");
        const result = await runMessagesEval({
          endpoint: parsed.messagesEndpoint ?? "http://localhost:8766",
          iterations: parsed.iterations,
          payloadSize: parsed.payloadSize,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

// ── Startup ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.error(`${SERVER_NAME}: starting MCP eval server v${SERVER_VERSION}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const handleSignal = async (signal: string) => {
    console.error(`${SERVER_NAME}: received ${signal}, shutting down...`);
    await server.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGINT", () => handleSignal("SIGINT"));
}

main().catch((e) => {
  console.error(`${SERVER_NAME}: fatal error:`, e);
  process.exit(1);
});
