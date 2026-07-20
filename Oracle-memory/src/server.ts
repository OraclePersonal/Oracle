import crypto from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { MemoryStore } from "./memory.js";
import type { MemoryType } from "./types.js";

const MEMORY_TYPES = ["fact", "insight", "chunk", "working"] as const;

// ─── Session Tracking ─────────────────────────────────

export interface SessionInfo {
  id: string;
  agent: string;
  transport: "stdio" | "http";
  connectedAt: string;
  lastActivity: string;
}

const sessions = new Map<string, SessionInfo>();

export function getSessions(): SessionInfo[] {
  return Array.from(sessions.values());
}

export function registerSession(id: string, agent: string, transport: "stdio" | "http"): void {
  sessions.set(id, {
    id,
    agent,
    transport,
    connectedAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
  });
}

export function updateSessionActivity(id: string): void {
  const session = sessions.get(id);
  if (session) {
    session.lastActivity = new Date().toISOString();
  }
}

export function unregisterSession(id: string): void {
  sessions.delete(id);
}

// ─── Server Factory ───────────────────────────────────

export function createServer(rootDir: string, disableVectors?: boolean): { server: McpServer; shutdown: () => Promise<void> } {
  const memory = new MemoryStore(rootDir, !disableVectors);

  // Start background TTL cleanup (every 5 minutes) and the maintenance cycle
  // (working→long-term promotion + stale pruning, every 15 minutes)
  memory.startTTLCleanup(300_000);
  memory.startMaintenanceCycle(900_000);

  const server = new McpServer(
    { name: "oracle-memory", version: "1.5.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: `# Oracle Memory Server

File-backed persistent memory for AI coding agents.

## Memory Types
- **fact** — Permanent knowledge (preferences, decisions, conventions)
- **insight** — Lessons learned from mistakes or discoveries
- **chunk** — Conversation snapshots auto-saved before context compact
- **working** — Session scratchpad (auto-cleared between sessions)

## Workflow
1. Use \`remember\` to save important information
2. Use \`recall\` to search across all memories
3. Use \`list_memories\` to browse by type or agent
4. Use \`clear_working\` between sessions

## Automatic maintenance (every 15 min, also callable manually)
- Every \`get_memory\` and every returned \`recall\` hit counts as an access —
  importance decays for memories nobody retrieves, and rises (with
  diminishing returns) for memories that keep getting reused.
- \`promote_memory\` — working memories retrieved 3+ times get promoted to
  \`insight\` (durable, long-term) automatically. A scratchpad note an agent
  keeps recalling is no longer a scratchpad note.
- \`prune_memories\` — durable memories that go 60+ days untouched and whose
  decayed importance drops below 0.2 are soft-archived (recoverable via
  \`list_memories\` with \`includeExpired\`), keeping recall results relevant.`,
    },
  );

  // ─── Tools ─────────────────────────────────────────────

  server.registerTool("remember", {
    description: "Save a memory (fact, insight, chunk, or working). If entry_id is provided, updates the existing memory instead of creating a new one. Durable fact/insight writes auto-detect contradictions — higher-trust supersedes lower, ties are flagged.",
    inputSchema: {
      agent: z.string().min(1).max(64),
      type: z.enum(MEMORY_TYPES),
      content: z.string().min(1),
      tags: z.array(z.string()).optional(),
      source: z.string().optional(),
      importance: z.number().min(0).max(1).optional(),
      ttl: z.number().int().positive().optional(),
      confidence: z.number().min(0).max(1).optional(),
      sourceTrust: z.number().min(0).max(1).optional(),
      checkConflicts: z.boolean().optional(),
      entry_id: z.string().optional().describe("Existing memory ID to update (omit to create new)"),
    },
  }, async (args) => {
    try {
      let entry;
      if (args.entry_id) {
        entry = await memory.updateMemory(args.entry_id, args.type as MemoryType, {
          content: args.content, tags: args.tags, importance: args.importance,
        });
        if (!entry) return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Memory not found" }) }], isError: true };
      } else {
        entry = await memory.remember(args.agent, args.type as MemoryType, args.content, {
          tags: args.tags, source: args.source, importance: args.importance, ttl: args.ttl,
          confidence: args.confidence, sourceTrust: args.sourceTrust, checkConflicts: args.checkConflicts,
        });
      }
      const conflicts = (entry.meta as Record<string, unknown> | undefined)?.conflictsResolved ?? [];
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, memory: entry, conflicts }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  });

  server.registerTool("recall", {
    description: "Search memories. Returns all when no query given. Use id to fetch one. Use graph_query to find entity relationships.",
    inputSchema: {
      query: z.string().optional().describe("Search query (empty = list all)"),
      id: z.string().optional().describe("Fetch a single memory by ID"),
      agent: z.string().optional(),
      type: z.enum(MEMORY_TYPES).optional(),
      tags: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(200).optional().default(20),
      includeExpired: z.boolean().optional(),
      graph_query: z.string().optional().describe("Entity name to explore in knowledge graph (e.g. 'Redis')"),
    },
  }, async (args) => {
    try {
      // Single memory by ID
      if (args.id) {
        const entry = await memory.getMemory(args.id, (args.type ?? "fact") as MemoryType);
        if (!entry) return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Memory not found" }) }], isError: true };
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, memory: entry }, null, 2) }] };
      }
      // Graph explain
      if (args.graph_query) {
        const results = await memory.searchMemories({
          query: args.graph_query, agent: args.agent, type: args.type as MemoryType | undefined,
          tags: args.tags, limit: args.limit ?? 20, includeExpired: args.includeExpired,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, results, count: results.length, note: "Related memories by entity graph" }, null, 2) }] };
      }
      // Search or list
      const results = await memory.searchMemories({
        query: args.query ?? "", agent: args.agent, type: args.type as MemoryType | undefined,
        tags: args.tags, limit: args.limit ?? 20, includeExpired: args.includeExpired,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, results, count: results.length }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  });

  server.registerTool("forget", {
    description: "Permanently delete a memory by ID and type, or clear all working memories for an agent.",
    inputSchema: {
      id: z.string().optional(),
      type: z.enum(MEMORY_TYPES).optional(),
      agent: z.string().optional().describe("Clear all working memories for this agent"),
    },
  }, async (args) => {
    try {
      if (args.agent) {
        const count = await memory.clearWorking(args.agent);
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, cleared: count }) }] };
      }
      if (!args.id || !args.type) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Provide id+type to delete one, or agent to clear working" }) }], isError: true };
      }
      const deleted = await memory.forget(args.id, args.type as MemoryType);
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, deleted }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  });

  server.registerTool("consolidate", {
    description: "Merge near-duplicate memories that share tag sets into one archived entry. Reduces clutter without losing information.",
    inputSchema: {},
  }, async () => {
    try {
      const result = await memory.consolidate();
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, ...result }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  });

  server.registerTool("promote_memory", {
    description: "Promote working memories retrieved 3+ times into durable 'insight' (or 'fact') memories. The working→long-term tier transition, callable on demand.",
    inputSchema: {
      min_access_count: z.number().int().min(1).max(100).optional().describe("Min retrievals to promote (default 3)"),
      target_type: z.enum(MEMORY_TYPES).optional().describe("Target type (default insight)"),
    },
  }, async (args) => {
    try {
      const promoted = await memory.promoteWorkingMemories({
        minAccessCount: args.min_access_count,
        targetType: (args.target_type as "fact" | "insight") ?? undefined,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, promoted: promoted.length, memories: promoted }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  });

  server.registerTool("prune_memories", {
    description: "Soft-archive durable memories untouched for min_stale_days whose decayed importance fell below min_importance. Recoverable via list_memories with includeExpired.",
    inputSchema: {
      min_importance: z.number().min(0).max(1).optional().describe("Decayed-importance floor (default 0.2)"),
      min_stale_days: z.number().int().min(1).optional().describe("Untouched days threshold (default 60)"),
    },
  }, async (args) => {
    try {
      const pruned = await memory.pruneStaleMemories({
        minImportance: args.min_importance,
        minStaleDays: args.min_stale_days,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, pruned: pruned.length, memories: pruned }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  });

  server.registerTool("reflect", {
    description: "LLM insight synthesis: cluster related memories and distill NEW higher-level insights, saved as durable 'insight' memories tagged 'reflection'. Requires ANTHROPIC_API_KEY + ORACLE_MEMORY_LLM_GRAPH=1; no-op (returns []) otherwise.",
    inputSchema: {
      agent: z.string().optional().describe("Agent name for the reflection (default 'reflector')"),
      max_clusters: z.number().int().min(1).max(50).optional().describe("Max clusters to process (default 8)"),
    },
  }, async (args) => {
    try {
      const created = await memory.reflect({ agent: args.agent, maxClusters: args.max_clusters });
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, created: created.length, memories: created }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  });

  server.registerTool("verify_memory", {
    description: "Resolve a contradiction explicitly. 'keep' un-quarantines a memory and invalidates what it contradicted; 'reject' invalidates the target itself. Manual override for write-time arbitration ties.",
    inputSchema: {
      id: z.string().min(1).describe("Memory ID to verify"),
      type: z.enum(MEMORY_TYPES),
      decision: z.enum(["keep", "reject"]),
    },
  }, async (args) => {
    try {
      const entry = await memory.verifyMemory(args.id, args.type as MemoryType, args.decision);
      if (!entry) return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Memory not found" }) }], isError: true };
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, memory: entry }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: (e as Error).message }) }], isError: true };
    }
  });

  // ─── Resources ─────────────────────────────────────────

  server.resource("All Memories", "oracle-memory://memories",
    { description: "All stored memories, newest first", mimeType: "application/json" },
    async (uri) => {
      const entries = await memory.listMemories({ limit: 200 });
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ memories: entries, count: entries.length }, null, 2) }] };
    },
  );

  server.resource("Memories by Type",
    new ResourceTemplate("oracle-memory://memories/{type}", {
      list: async () => ({
        resources: MEMORY_TYPES.map((t) => ({ uri: `oracle-memory://memories/${t}`, name: `${t} memories`, mimeType: "application/json" })),
      }),
    }),
    { description: "Memories filtered by type", mimeType: "application/json" },
    async (uri, vars) => {
      const type = vars.type as MemoryType;
      const entries = await memory.listByType(type);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ type, memories: entries, count: entries.length }, null, 2) }] };
    },
  );

  server.resource("Memory Statistics", "oracle-memory://stats",
    { description: "Memory count statistics by type and agent", mimeType: "application/json" },
    async (uri) => {
      const stats = await memory.getStats();
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(stats, null, 2) }] };
    },
  );

  server.resource("Active Sessions", "oracle-memory://sessions",
    { description: "Currently connected agent sessions", mimeType: "application/json" },
    async (uri) => {
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ sessions: getSessions() }, null, 2) }] };
    },
  );

  server.resource("Conflicts", "oracle-memory://conflicts",
    { description: "Unresolved contradictions and quarantined memories", mimeType: "application/json" },
    async (uri) => {
      const conflicts = await memory.listConflicts();
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ ...conflicts, flaggedCount: conflicts.flagged.length, quarantinedCount: conflicts.quarantined.length }, null, 2) }] };
    },
  );

  async function shutdown(): Promise<void> {
    memory.stopTTLCleanup();
    memory.stopMaintenanceCycle();
    // Close the MCP server (graceful disconnect)
    try {
      await server.close();
    } catch {
      // server may not be connected yet
    }
  }

  return { server, shutdown };
}

// ─── Transports ───────────────────────────────────────

export async function runStdio(rootDir: string, disableVectors?: boolean): Promise<() => Promise<void>> {
  const { server, shutdown } = createServer(rootDir, disableVectors);
  const transport = new StdioServerTransport();
  // Stdio is a persistent single session — register immediately.
  // After server.connect() the SDK overwrites transport.onmessage,
  // so we register the session here before that happens.
  registerSession("stdio-main", "stdio", "stdio");
  await server.connect(transport);
  return shutdown;
}

export async function runHttp(rootDir: string, disableVectors?: boolean, port?: number, host?: string): Promise<() => Promise<void>> {
  const { createServer: createHttpServer } = await import("node:http");

  const { server: mcpServer, shutdown } = createServer(rootDir, disableVectors);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  const httpServer = createHttpServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Session-Id");

    // ponytail: public HTTP hub has no body cap by default — bound request
    // size (1MB) + idle timeout (30s) so a single agent can't OOM the daemon.
    // Raise MAX_BODY_BYTES / REQ_TIMEOUT_MS if real payloads exceed them.
    const MAX_BODY_BYTES = 1_000_000;
    const REQ_TIMEOUT_MS = 30_000;
    req.setTimeout(REQ_TIMEOUT_MS, () => {
      if (!res.headersSent) {
        res.writeHead(408, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request timeout" }));
      }
      req.destroy();
    });
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload too large" }));
        req.destroy();
      }
    });

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check
    const token = process.env.ORACLE_MEMORY_HTTP_TOKEN;
    if (token) {
      const header = req.headers["authorization"] as string | undefined;
      if (!header || !header.startsWith("Bearer ") || header.slice(7) !== token) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      // Health check endpoint
      if (url.pathname === "/health" || url.pathname === "/health/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", uptime: process.uptime(), sessions: sessions.size }));
        return;
      }

      // Only handle MCP requests at the MCP endpoint
      if (!url.pathname.endsWith("/mcp")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found. Use POST /mcp for MCP requests." }));
        return;
      }

      const agent = url.searchParams.get("agent") ?? "unknown";
      const sessionId = (req.headers["mcp-session-id"] as string) ?? url.searchParams.get("sessionId") ?? crypto.randomUUID();

      if (!sessions.has(sessionId)) {
        registerSession(sessionId, agent, "http");
      }
      updateSessionActivity(sessionId);

      await transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    }
  });

  const bindPort = port ?? parseInt(process.env.ORACLE_MEMORY_PORT ?? process.env.AGOYA_PORT ?? "8765", 10);
  const bindHost = host ?? process.env.ORACLE_MEMORY_HOST ?? process.env.AGOYA_HOST ?? "0.0.0.0";

  await mcpServer.connect(transport);

  httpServer.listen(bindPort, bindHost, () => {
    console.error(`oracle-memory: HTTP server listening on http://${bindHost}:${bindPort}/mcp`);
  });

  // Cleanup stale HTTP sessions every 5 minutes (stdio is persistent)
  setInterval(() => {
    const stale = Date.now() - 5 * 60 * 1000;
    for (const [id, session] of sessions) {
      if (session.transport === "stdio") continue; // persistent session
      if (new Date(session.lastActivity).getTime() < stale) {
        sessions.delete(id);
      }
    }
  }, 300_000);

  return shutdown;
}

export async function runServer(rootDir: string, disableVectors?: boolean): Promise<() => Promise<void>> {
  const transport = (process.env.ORACLE_MEMORY_TRANSPORT ?? process.env.AGOYA_TRANSPORT ?? "stdio").toLowerCase();
  if (transport === "http" || transport === "streamable") {
    return runHttp(rootDir, disableVectors);
  }
  return runStdio(rootDir, disableVectors);
}
