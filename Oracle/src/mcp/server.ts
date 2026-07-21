import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ProjectConfig } from "../config/project.js";
import type { ConsultService } from "../core/consult.js";
import { OracleError, serializeOracleError } from "../errors.js";
import { checkProvider } from "../providers/factory.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { OracleRegistry } from "../oracles/registry.js";
import { ProfileStore } from "../identity/profile.js";
import type { MemoryPort } from "../orchestrator/ports.js";
import type { PRFile } from "../github/types.js";
import * as gh from "../github/gh.js";
import { listDocs, searchDocs, addDoc, removeDoc } from "../docs/reader.js";
import { getConversationContext, recordSelfLog } from "../core/selfMemory.js";
import { loadSoul } from "../core/souls.js";
import { buildOracleSystemPrompt } from "../core/systemPrompt.js";
import { buildWiki, getWikiPage, listWikiTopics } from "../wiki/compile.js";
import { webSearchWithTrace } from "../web/search.js";
import { fetchUrl } from "../web/fetchUrl.js";
import { agentqlExtract } from "../web/providers/agentql.js";
import { SEARCH_PROVIDERS, FETCH_PROVIDERS } from "../web/types.js";
import type { AgentService } from "../agent/service.js";
import type { MessageStore } from "../messaging/store.js";

interface OracleServerDependencies {
  server: McpServer;
  service: ConsultService;
  config: ProjectConfig;
  workspaceRoot: string;
  providerId: string;
  skills: SkillRegistry;
  oracles: OracleRegistry;
  memory: MemoryPort;
  profile: ProfileStore;
  messages: MessageStore;
  providerChecks?: typeof checkProvider;
  agent?: AgentService;
  agentUnavailableReason?: string;
}

/**
 * Accepts either a single string or an array of strings, always normalizing
 * to an array. Free-text-shaped fields like "preferences"/"habits"/"goals"
 * read naturally to an LLM caller as a single descriptive string ("prefers
 * concise diffs") even though the stored shape is a list of discrete items
 * — rejecting the string form with a bare type error is a common first-call
 * failure. Splitting on commas/semicolons/newlines gives a single freeform
 * sentence a reasonable chance of becoming several discrete items instead
 * of one giant one, without forcing the caller to pre-structure it.
 */
function stringOrStringArray() {
  return z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      if (Array.isArray(value)) return value;
      return value
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    });
}

function success(text: string, structuredContent: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent };
}

function failure(error: unknown) {
  const serialized = serializeOracleError(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(serialized) }],
    structuredContent: serialized as unknown as Record<string, unknown>
  };
}

export function registerOracleTools({
  server,
  service,
  config,
  workspaceRoot,
  providerId,
  skills,
  oracles,
  memory,
  profile,
  messages,
  providerChecks = checkProvider,
  agent,
  agentUnavailableReason,
  soulsDir = path.join(os.homedir(), ".oracle", "souls")
}: OracleServerDependencies & { soulsDir?: string }): void {
  server.registerTool(
    "oracle_agent",
    {
      title: "Run Oracle Agent",
      description: "Autonomously carry out a coding task in the workspace with a tool-use loop.",
      inputSchema: {
        prompt: z.string().min(1).max(50000),
        readOnly: z.boolean().optional(),
        skill: z.string().optional().describe("Skill to apply (review, debug, security, architecture, tests)"),
        maxSteps: z.number().int().min(1).max(50).optional()
      }
    },
    async ({ prompt, readOnly, skill, maxSteps }) => {
      try {
        if (!agent) {
          throw new OracleError(
            "ORACLE_AGENT_UNAVAILABLE",
            "The agent is not available with the configured provider.",
            agentUnavailableReason ?? "Set provider to 'anthropic' or 'opencode' in .oracle/config.json."
          );
        }
        const result = await agent.run({ prompt, workspaceRoot, model: config.model, readOnly, skill, maxSteps });
        return success(result.finalText, {
          finalText: result.finalText,
          steps: result.steps,
          stoppedOnLimit: result.stoppedOnLimit,
          turns: result.steps.length,
          usage: result.usage,
          readOnly: readOnly ?? false,
          skill: skill ?? undefined
        });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "oracle_ask",
    {
      title: "Ask Oracle",
      description: "Ask Oracle anything — a question, or 'look at these files and tell me X'. One entry point: pass `files` when the answer needs actual code, omit it for a plain conversation. Pass `conversationId` across calls in the same exchange so Oracle remembers what it already told you.",
      inputSchema: {
        question: z.string().min(1).describe("Your question or what you're stuck on"),
        soul: z.string().optional().describe("Soul prompt name (e.g. 'engineer', 'philosopher'). Defaults to 'default'"),
        context: z.string().optional().describe("Additional context: code snippets, error messages, what you've tried"),
        files: z.array(z.string()).optional().describe("File paths or glob patterns to read and include, when the question needs real code (e.g. ['src/**/*.ts'])"),
        conversationId: z.string().optional().describe("Stable id for this exchange — pass the same value across multiple oracle_ask calls so Oracle recalls what it already said"),
        include_docs: z.boolean().optional().describe("Search .oracle/docs/ for relevant documentation and include as context"),
        doc_search: z.string().optional().describe("Specific doc query (defaults to using the question itself)")
      }
    },
    async ({ question, soul, context, files, conversationId, include_docs, doc_search }) => {
      try {
        if (soul !== undefined) {
          soul = soul.trim();
          if (soul === "") soul = undefined;
        }
        // Build system prompt — use specific soul if given, otherwise auto-detect mood
        let soulName: string;
        let soulPrompt: string | undefined;
        if (soul) {
          soulName = soul;
          soulPrompt = await loadSoul(soulName, soulsDir);
        } else {
          soulName = "auto";
        }
        const systemPrompt = buildOracleSystemPrompt(soulPrompt);
        let ctxBlock = context ? `\n\n## Context from the asking agent\n${context}` : "";

        if (conversationId) {
          ctxBlock += await getConversationContext(memory, conversationId);
        }

        // Include relevant docs from .oracle/docs/
        if (include_docs) {
          const docQuery = doc_search ?? question;
          const matched = await searchDocs(workspaceRoot, docQuery, 5);
          if (matched.length > 0) {
            const docsBlock = matched
              .map((d) => `### ${d.name}${d.heading ? ` — ${d.heading}` : ""}\n${d.snippet}`)
              .join("\n\n");
            ctxBlock += `\n\n## Documentation from .oracle/docs/\n${docsBlock}\n\n(Match: "${docQuery}")`;
          }
        }

        const prompt = `${ctxBlock}\n\n## Question\n${question}`;
        const hasFiles = files !== undefined && files.length > 0;
        const result = await service.consult({
          prompt,
          preset: "review",
          provider: providerId,
          files: hasFiles ? files : [],
          model: config.model,
          cwd: workspaceRoot,
          maxFileSizeBytes: config.maxFileSizeBytes,
          maxInputBytes: config.maxInputBytes,
          systemPrompt,
          allowEmptyFiles: !hasFiles,
        });

        if (conversationId) {
          await recordSelfLog(memory, conversationId, { question, answerSummary: result.output.slice(0, 400) });
        }

        return success(result.output, {
          soul: soulName,
          sessionId: result.sessionId,
          filesIncluded: result.files.length
        });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "oracle_skills",
    {
      title: "List Skills",
      description: "List available Oracle skills.",
      inputSchema: {}
    },
    async () => {
      try {
        const list = skills.list().map((s) => ({
          name: s.name,
          description: s.description,
          model: s.model ?? null,
          filePatterns: s.filePatterns ?? null
        }));
        return success(JSON.stringify(list, null, 2), { skills: list });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "oracle_sessions",
    {
      title: "List Oracle Sessions",
      description: "List recent consultations without bundled source content.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(20) }
    },
    async ({ limit }) => {
      try {
        const records = await service.listSessions(limit);
        const sessions = records.map((record) => ({
          sessionId: record.sessionId,
          status: record.status,
          model: record.model,
          provider: record.provider,
          preset: record.preset,
          createdAt: record.createdAt,
          completedAt: record.completedAt,
          fileCount: record.files.length,
          prompt: record.prompt.length > 120 ? `${record.prompt.slice(0, 117)}...` : record.prompt
        }));
        return success(JSON.stringify(sessions, null, 2), { sessions });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "oracle_session_get",
    {
      title: "Get Oracle Session",
      description: "Read persisted session metadata and model output.",
      inputSchema: { sessionId: z.string().regex(/^[a-z0-9-]+-[a-f0-9]{8}$/) }
    },
    async ({ sessionId }) => {
      try {
        const record = await service.session(sessionId);
        if (!record) {
          throw new OracleError(
            "ORACLE_SESSION_NOT_FOUND",
            `Session not found: ${sessionId}`,
            "Call oracle_sessions to discover available session IDs."
          );
        }
        const { bundlePath: _bundlePath, ...safeRecord } = record;
        return success(record.output || JSON.stringify(safeRecord, null, 2), safeRecord);
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "oracle_oracle_list",
    {
      title: "List Oracles",
      description: "List registered oracle profiles.",
      inputSchema: {}
    },
    async () => {
      try {
        const list = await oracles.listOracles();
        return success(JSON.stringify(list, null, 2), { oracles: list });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_oracle_register",
    {
      title: "Register Oracle",
      description: "Create a named oracle profile with a skill.",
      inputSchema: {
        name: z.string().min(1),
        skill: z.string().min(1),
        description: z.string().optional(),
        model: z.string().optional(),
        provider: z.string().optional(),
        memory: z.boolean().optional()
      }
    },
    async (params) => {
      try {
        await oracles.registerOracle({
          name: params.name,
          skill: params.skill,
          description: params.description,
          model: params.model,
          provider: params.provider,
          memory: params.memory
        });
        return success(`Registered oracle: ${params.name}`, { name: params.name });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_list",
    {
      title: "List Memory",
      description: "Show memory entries from the .oracle-memory store.",
      inputSchema: { agent: z.string().optional(), type: z.enum(["fact", "insight", "chunk", "working"]).optional(), limit: z.number().int().min(1).max(100).default(10) }
    },
    async ({ agent, type, limit }) => {
      try {
        const entries = await memory.recall({ type, agent: agent ?? undefined, limit });
        return success(JSON.stringify(entries, null, 2), { entries });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_search",
    {
      title: "Search Memory",
      description: "Search memory contents by keyword.",
      inputSchema: { query: z.string().min(1), agent: z.string().optional(), type: z.enum(["fact", "insight", "chunk", "working"]).optional(), limit: z.number().int().min(1).max(200).default(20) }
    },
    async ({ query, agent, type, limit }) => {
      try {
        const entries = await memory.searchMemories(query, { type: type as any, agent: agent ?? undefined, limit });
        return success(JSON.stringify(entries, null, 2), { count: entries.length, entries });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_update",
    {
      title: "Update Memory",
      description: "Update content, tags, or importance of an existing memory.",
      inputSchema: { id: z.string(), type: z.enum(["fact", "insight", "chunk", "working"]), content: z.string().optional(), tags: z.array(z.string()).optional(), importance: z.number().min(0).max(1).optional() }
    },
    async ({ id, type, content, tags, importance }) => {
      try {
        const updated = await memory.updateMemory(id, type as any, { content, tags, importance });
        if (!updated) return failure(new Error("Memory not found"));
        return success(JSON.stringify(updated, null, 2), { memory: updated });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_stats",
    {
      title: "Memory Stats",
      description: "Get memory counts by type and agent.",
      inputSchema: {}
    },
    async () => {
      try {
        const stats = await memory.getStats();
        return success(JSON.stringify(stats, null, 2), { stats });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_clear",
    {
      title: "Clear Memory",
      description: "Clear working memory for an agent or all.",
      inputSchema: { agent: z.string().optional() }
    },
    async ({ agent }) => {
      try {
        const count = await memory.clearWorking(agent ?? undefined);
        return success(`Cleared ${count} working memory entries.`, { cleared: count });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_scored_search",
    {
      title: "Scored Memory Search",
      description: "Semantic search with recency-weighted scoring — combines vector similarity, importance, access frequency, and recency boost.",
      inputSchema: {
        query: z.string().min(1),
        agent: z.string().optional(),
        type: z.enum(["fact", "insight", "chunk", "working"]).optional(),
        limit: z.number().int().min(1).max(200).default(20)
      }
    },
    async ({ query, agent, type, limit }) => {
      try {
        const entries = await memory.scoredSearchMemories(query, { agent: agent ?? undefined, type: type as any, limit });
        return success(JSON.stringify(entries, null, 2), { count: entries.length, entries });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_graph_query",
    {
      title: "Entity Graph Search",
      description: "Entity-aware memory search — expands query with related entities from the knowledge graph for richer results.",
      inputSchema: {
        query: z.string().min(1),
        agent: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(20)
      }
    },
    async ({ query, agent, limit }) => {
      try {
        const entries = await memory.graphQuery?.(query, { agent: agent ?? undefined, limit }) ?? [];
        return success(JSON.stringify(entries, null, 2), { count: entries.length, entries });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_graph_path",
    {
      title: "Entity Relationship Path",
      description: "Find the shortest relationship path between two entities in the knowledge graph.",
      inputSchema: {
        from: z.string().min(1),
        to: z.string().min(1)
      }
    },
    async ({ from, to }) => {
      try {
        const path = await memory.graphFindPath?.(from, to) ?? [];
        return success(JSON.stringify(path, null, 2), { hops: path.length, path });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_graph_stats",
    {
      title: "Entity Graph Stats",
      description: "Entity count and edge count statistics for the memory knowledge graph.",
      inputSchema: {}
    },
    async () => {
      try {
        const stats = await memory.getGraphStats?.() ?? { entityCount: 0, edgeCount: 0 };
        return success(JSON.stringify(stats, null, 2), { stats });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_graph_prune",
    {
      title: "Prune Entity Graph",
      description: "Remove stale isolated entities and orphaned edges from the knowledge graph to control growth.",
      inputSchema: {
        max_age_days: z.number().int().min(1).optional().describe("Max age in days for isolated nodes (default 90)")
      }
    },
    async ({ max_age_days }) => {
      try {
        const result = await memory.graphPrune?.(max_age_days) ?? { removedEntities: 0, removedEdges: 0 };
        return success(`Pruned ${result.removedEntities} entities and ${result.removedEdges} edges.`, { ...result });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_consolidate",
    {
      title: "Consolidate Memories",
      description: "Merge near-duplicate memories that share tag sets — reduces clutter without losing information.",
      inputSchema: {}
    },
    async () => {
      try {
        const result = await memory.consolidate?.() ?? { consolidated: 0, created: null, archived: [] };
        return success(JSON.stringify(result, null, 2), { ...result });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_prune",
    {
      title: "Prune Stale Memories",
      description: "Soft-archive durable memories untouched for N days with low importance. Recoverable via recall with includeArchived.",
      inputSchema: {
        min_importance: z.number().min(0).max(1).optional().describe("Decayed-importance floor (default 0.2)"),
        min_stale_days: z.number().int().min(1).optional().describe("Untouched days threshold (default 30)")
      }
    },
    async ({ min_importance, min_stale_days }) => {
      try {
        const pruned = await memory.pruneStale?.({ minImportance: min_importance, minStaleDays: min_stale_days }) ?? [];
        return success(`Pruned ${pruned.length} memories.`, { count: pruned.length, ids: pruned });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_promote",
    {
      title: "Promote Working Memories",
      description: "Promote working memories retrieved 3+ times into durable 'insight' memories for long-term retention.",
      inputSchema: {
        min_access_count: z.number().int().min(1).max(100).optional().describe("Min retrievals to promote (default 3)")
      }
    },
    async ({ min_access_count }) => {
      try {
        const promoted = await memory.promoteWorking?.({ minAccessCount: min_access_count }) ?? [];
        return success(`Promoted ${promoted.length} working memories to insight.`, { count: promoted.length, ids: promoted });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_maintenance",
    {
      title: "Run Memory Maintenance",
      description: "Run both prune (stale low-value) and promote (frequently-accessed working → insight) in one call.",
      inputSchema: {
        min_importance: z.number().min(0).max(1).optional(),
        min_stale_days: z.number().int().min(1).optional(),
        min_access_count: z.number().int().min(1).max(100).optional()
      }
    },
    async ({ min_importance, min_stale_days, min_access_count }) => {
      try {
        const result = await memory.runMaintenance?.({ minImportance: min_importance, minStaleDays: min_stale_days, minAccessCount: min_access_count }) ?? { pruned: [], promoted: [] };
        return success(`Pruned ${result.pruned.length}, promoted ${result.promoted.length}.`, { ...result });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_reflect",
    {
      title: "Memory Reflection",
      description: "LLM insight synthesis: cluster related memories and distill NEW higher-level insights, saved as 'insight' memories. Requires ANTHROPIC_API_KEY.",
      inputSchema: {
        agent: z.string().optional().describe("Agent name for the reflection")
      }
    },
    async ({ agent }) => {
      try {
        const insights = await memory.reflect?.({ agent: agent ?? undefined }) ?? [];
        return success(JSON.stringify(insights, null, 2), { count: insights.length, insights });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_wiki_build",
    {
      title: "Build Memory Wiki",
      description: "Compile all facts/insights into topic-grouped wiki pages under .oracle/wiki/ — a readable view over memory, not a second copy of it.",
      inputSchema: {}
    },
    async () => {
      try {
        const result = await buildWiki(memory, workspaceRoot);
        return success(`Compiled ${result.topics.length} topic(s).`, { ...result });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_wiki_list",
    {
      title: "List Wiki Topics",
      description: "List topics from the last oracle_memory_wiki_build.",
      inputSchema: {}
    },
    async () => {
      try {
        const topics = await listWikiTopics(workspaceRoot);
        return success(JSON.stringify(topics, null, 2), { topics });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_wiki_get",
    {
      title: "Get Wiki Page",
      description: "Read a compiled wiki topic page. Run oracle_memory_wiki_build first if it doesn't exist yet.",
      inputSchema: { topic: z.string().min(1) }
    },
    async ({ topic }) => {
      try {
        const page = await getWikiPage(workspaceRoot, topic);
        if (!page) throw new OracleError("ORACLE_INVALID_REQUEST", `Wiki topic not found: ${topic}`, "Run oracle_memory_wiki_build or oracle_memory_wiki_list.");
        return success(page, { topic });
      } catch (error) { return failure(error); }
    }
  );

  // ─── Docs ────────────────────────────────────────

  server.registerTool(
    "oracle_docs_list",
    {
      title: "List Docs",
      description: "List available documentation files in .oracle/docs/.",
      inputSchema: {}
    },
    async () => {
      try {
        const docs = await listDocs(workspaceRoot);
        const summary = docs.map((d) => ({ name: d.name, size: d.size }));
        return success(JSON.stringify(summary, null, 2), { count: docs.length, docs: summary });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_docs_search",
    {
      title: "Search Docs",
      description: "BM25-ranked passage search over .oracle/docs/ — chunked by heading, not whole files.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).default(5),
      }
    },
    async ({ query, limit }) => {
      try {
        const results = await searchDocs(workspaceRoot, query, limit);
        return success(JSON.stringify(results, null, 2), { count: results.length, results });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_docs_add",
    {
      title: "Add Doc",
      description: "Add or overwrite a file in .oracle/docs/ (.md, .txt, .json, .mdx).",
      inputSchema: {
        name: z.string().min(1).describe("Relative filename, e.g. 'auth/oauth.md'"),
        content: z.string()
      }
    },
    async ({ name, content }) => {
      try {
        const filePath = await addDoc(workspaceRoot, name, content);
        return success(`Added ${name}`, { path: filePath });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_docs_remove",
    {
      title: "Remove Doc",
      description: "Delete a file from .oracle/docs/.",
      inputSchema: { name: z.string().min(1) }
    },
    async ({ name }) => {
      try {
        const removed = await removeDoc(workspaceRoot, name);
        if (!removed) return failure(new Error(`Doc not found: ${name}`));
        return success(`Removed ${name}`, { name });
      } catch (error) { return failure(error); }
    }
  );

  // ─── Web ─────────────────────────────────────────

  server.registerTool(
    "oracle_web_search",
    {
      title: "Web Search",
      description: "Search the web via Brave, Tavily, or Firecrawl. Defaults to the first provider with a configured API key.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).default(5),
        provider: z.enum(SEARCH_PROVIDERS as [string, ...string[]]).optional()
      }
    },
    async ({ query, limit, provider }) => {
      try {
        const outcome = await webSearchWithTrace(query, limit, provider as any);
        return success(JSON.stringify(outcome.results, null, 2), {
          count: outcome.results.length,
          results: outcome.results,
          provider: outcome.provider,
          attempts: outcome.attempts
        });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_web_fetch",
    {
      title: "Fetch URL",
      description: "Fetch a URL and return its readable text. 'native' strips HTML itself (SSRF-guarded); 'firecrawl' uses Firecrawl's JS-rendering scraper (requires FIRECRAWL_API_KEY).",
      inputSchema: {
        url: z.string().min(1),
        provider: z.enum(FETCH_PROVIDERS as [string, ...string[]]).default("native")
      }
    },
    async ({ url, provider }) => {
      try {
        const page = await fetchUrl(url, provider as any);
        return success(page.text, { url: page.url, title: page.title, length: page.text.length });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_web_extract",
    {
      title: "Extract Structured Data",
      description: "Extract structured data from a URL via TinyFish's AgentQL API given a natural-language description of the fields to pull out. Requires AGENTQL_API_KEY.",
      inputSchema: {
        url: z.string().min(1),
        prompt: z.string().min(1).describe("What to extract, e.g. 'the product name, price, and in-stock status'")
      }
    },
    async ({ url, prompt }) => {
      try {
        const result = await agentqlExtract(url, prompt);
        return success(JSON.stringify(result.data, null, 2), { data: result.data, sourceUrl: result.sourceUrl });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_identity_show",
    {
      title: "Show Identity",
      description: "Show your identity profile and Oracle's persona.",
      inputSchema: {}
    },
    async () => {
      try {
        const identity = await profile.getIdentity();
        const persona = await profile.getPersona();
        return success(JSON.stringify({ identity, persona }, null, 2), { identity, persona });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_identity_setup",
    {
      title: "Set Identity",
      description: "Set up your identity profile.",
      inputSchema: {
        name: z.string().min(1),
        title: z.string().optional(),
        role: z.string().optional(),
        description: z.string().optional(),
        preferences: stringOrStringArray(),
        habits: stringOrStringArray(),
        goals: stringOrStringArray()
      }
    },
    async (params) => {
      try {
        await profile.saveIdentity({
          name: params.name,
          title: params.title,
          role: params.role,
          description: params.description,
          preferences: params.preferences,
          habits: params.habits,
          goals: params.goals
        });
        return success(`Identity saved for ${params.name}.`, { name: params.name });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_persona_set",
    {
      title: "Set Persona",
      description: "Set Oracle's voice and personality.",
      inputSchema: {
        name: z.string().default("Oracle"),
        tone: z.enum(["professional", "casual", "friendly", "witty"]).default("professional"),
        style: z.string().optional(),
        greeting: z.string().optional()
      }
    },
    async (params) => {
      try {
        await profile.savePersona({
          name: params.name,
          tone: params.tone as any,
          style: params.style,
          greeting: params.greeting
        });
        return success(`Persona saved: ${params.name}`, { name: params.name });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_doctor",
    {
      title: "Check Oracle",
      description: "Check project configuration and provider readiness.",
      inputSchema: {}
    },
    async () => {
      try {
        const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
        const sessionProbe = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-doctor-"));
        await fs.rm(sessionProbe, { recursive: true, force: true });
        await fs.access(workspaceRoot, fs.constants.R_OK);
        const checks = [
          {
            name: "node runtime",
            ok: nodeMajor >= 24,
            detail: `Node.js ${process.versions.node}; requires 24 or newer`
          },
          { name: "project configuration", ok: true, detail: `${providerId}/${config.model}` },
          { name: "workspace readable", ok: true, detail: workspaceRoot },
          { name: "session storage writable", ok: true, detail: os.tmpdir() },
          ...(await providerChecks(config.provider))
        ];
        return success(JSON.stringify(checks, null, 2), {
          healthy: checks.every((check) => check.ok),
          checks
        });
      } catch (error) {
        return failure(error);
      }
    }
  );

  // ── Inter-agent messaging ──────────────────────────────────────
  // Oracle as relay: all oracle-mcp processes on this machine share
  // ~/.oracle/messages, so agents in different sessions can exchange messages.

  server.registerTool(
    "oracle_msg_send",
    {
      title: "Send Agent Message",
      description:
        "Send a message to another agent through Oracle's shared message bus. Use to: '*' to broadcast to all agents. Set replyTo to continue a thread.",
      inputSchema: {
        from: z.string().min(1).describe("Your agent name, e.g. 'claude-code'"),
        to: z.string().min(1).describe("Recipient agent name, or '*' for broadcast"),
        body: z.string().min(1).max(20000),
        subject: z.string().max(200).optional(),
        replyTo: z.string().optional().describe("Message id this replies to")
      }
    },
    async ({ from, to, body, subject, replyTo }) => {
      try {
        const msg = await messages.send({ from, to, body, subject, replyTo });
        return success(`Sent ${msg.id} to ${to}.`, { id: msg.id, ts: msg.ts, to });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_msg_inbox",
    {
      title: "Check Agent Inbox",
      description:
        "Read messages addressed to you (including broadcasts). Unread only by default; ack them with oracle_msg_ack after handling.",
      inputSchema: {
        agent: z.string().min(1).describe("Your agent name"),
        unreadOnly: z.boolean().default(true),
        limit: z.number().int().min(1).max(200).default(50)
      }
    },
    async ({ agent: agentName, unreadOnly, limit }) => {
      try {
        const inbox = await messages.inbox(agentName, { unreadOnly, limit });
        const lines = inbox.map(
          (m) => `${m.id} | ${m.ts} | from ${m.from}${m.subject ? ` | ${m.subject}` : ""}\n${m.body}`
        );
        return success(
          inbox.length ? lines.join("\n---\n") : "Inbox empty.",
          { count: inbox.length, messages: inbox as unknown as Record<string, unknown>[] }
        );
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_msg_ack",
    {
      title: "Acknowledge Messages",
      description: "Mark messages as read so they stop appearing in your unread inbox.",
      inputSchema: {
        agent: z.string().min(1).describe("Your agent name"),
        ids: z.array(z.string().min(1)).min(1).max(200)
      }
    },
    async ({ agent: agentName, ids }) => {
      try {
        const acked = await messages.ack(agentName, ids);
        return success(`Acked ${acked.length}/${ids.length}.`, { acked });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_msg_thread",
    {
      title: "Read Message Thread",
      description: "Fetch the full conversation thread containing the given message id.",
      inputSchema: { id: z.string().min(1) }
    },
    async ({ id }) => {
      try {
        const thread = await messages.thread(id);
        const lines = thread.map((m) => `${m.id} | ${m.ts} | ${m.from} → ${m.to}\n${m.body}`);
        return success(
          thread.length ? lines.join("\n---\n") : `No thread found for ${id}.`,
          { count: thread.length, messages: thread as unknown as Record<string, unknown>[] }
        );
      } catch (error) { return failure(error); }
    }
  );

  // ── GitHub tools ────────────────────────────────────────────────

  server.registerTool(
    "oracle_github_pr_get",
    {
      title: "Get PR Details",
      description: "Get details of a GitHub pull request.",
      inputSchema: {
        number: z.number().int().positive(),
        repo: z.string().optional().describe("owner/repo, defaults to inferred from git remote")
      }
    },
    async ({ number, repo }) => {
      try {
        const r = repo ?? gh.inferRepo(workspaceRoot);
        const pr = gh.getPR(number, r);
        return success(JSON.stringify(pr, null, 2), pr as unknown as Record<string, unknown>);
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_github_pr_list",
    {
      title: "List PRs",
      description: "List GitHub pull requests with filters.",
      inputSchema: {
        repo: z.string().optional().describe("owner/repo, defaults to inferred from git remote"),
        state: z.enum(["open", "closed", "merged", "all"]).default("open"),
        limit: z.number().int().min(1).max(100).default(30),
        base: z.string().optional(),
        head: z.string().optional(),
        author: z.string().optional(),
        labels: z.string().optional().describe("comma-separated")
      }
    },
    async ({ repo, state, limit, base, head, author, labels }) => {
      try {
        const r = repo ?? gh.inferRepo(workspaceRoot);
        const prs = gh.listPRs({ repo: r, state, limit, base, head, author, labels: labels?.split(",") });
        return success(JSON.stringify(prs, null, 2), { count: prs.length, prs: prs as unknown as Record<string, unknown>[] });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_github_pr_diff",
    {
      title: "Get PR Diff",
      description: "Get the full diff for a pull request.",
      inputSchema: {
        number: z.number().int().positive(),
        repo: z.string().optional().describe("owner/repo, defaults to inferred from git remote")
      }
    },
    async ({ number, repo }) => {
      try {
        const r = repo ?? gh.inferRepo(workspaceRoot);
        const diff = gh.getPRDiff(number, r);
        return success(diff, { number, diffLength: diff.length });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_github_pr_files",
    {
      title: "Get PR Files",
      description: "Get the list of changed files in a pull request.",
      inputSchema: {
        number: z.number().int().positive(),
        repo: z.string().optional().describe("owner/repo, defaults to inferred from git remote")
      }
    },
    async ({ number, repo }) => {
      try {
        const r = repo ?? gh.inferRepo(workspaceRoot);
        const files = gh.getPRFiles(number, r);
        return success(JSON.stringify(files, null, 2), { count: files.length, files: files as unknown as Record<string, unknown>[] });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_github_pr_review",
    {
      title: "Review PR",
      description: "Review a pull request using Oracle's consult engine. Returns AI analysis. Does NOT post the review to GitHub — use oracle_github_pr_review_submit to post.",
      inputSchema: {
        number: z.number().int().positive(),
        repo: z.string().optional().describe("owner/repo, defaults to inferred from git remote")
      }
    },
    async ({ number, repo }) => {
      try {
        const r = repo ?? gh.inferRepo(workspaceRoot);
        const pr = gh.getPR(number, r);
        const diff = gh.getPRDiff(number, r);
        const files = gh.getPRFiles(number, r);
        const fileList = files.map((f: PRFile) => `  ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`).join("\n");
        const reviewPrompt = [
          `## PR Review: #${number} — ${pr.title}`,
          `**Author:** ${pr.author}  **Repo:** ${r}`,
          `**Base:** ${pr.baseRef} ← **Head:** ${pr.headRef}`,
          "",
          pr.body ? `### Description\n${pr.body}\n` : "",
          `### Changed Files (${files.length})`,
          fileList,
          "",
          "### Diff",
          "```diff",
          diff.slice(0, 50000),
          "```",
          "",
          "Review this PR for correctness, edge cases, security, and maintainability.",
          "Be specific — cite line numbers from the diff. Categorize findings by severity (critical/major/minor/nit).",
        ].filter(Boolean).join("\n");

        const result = await service.consult({
          prompt: reviewPrompt,
          preset: "review",
          provider: providerId,
          model: config.model,
          cwd: workspaceRoot,
          systemPrompt: "You are a senior code reviewer. Analyze the PR diff and files. Be specific, cite line numbers, and categorize findings by severity (critical/major/minor/nit). End with a verdict: approve, request changes, or comment."
        });

        return success(result.output, {
          sessionId: result.sessionId,
          prNumber: number,
          repo: r,
          files: files.length,
          diffBytes: diff.length
        });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_github_pr_review_submit",
    {
      title: "Submit PR Review",
      description: "Submit a review on a pull request (APPROVE, REQUEST_CHANGES, or COMMENT).",
      inputSchema: {
        number: z.number().int().positive(),
        body: z.string().describe("Review body text"),
        event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).default("COMMENT"),
        repo: z.string().optional().describe("owner/repo, defaults to inferred from git remote")
      }
    },
    async ({ number, body, event, repo }) => {
      try {
        const r = repo ?? gh.inferRepo(workspaceRoot);
        gh.submitPRReview(number, body, event, r);
        return success(`Review submitted on PR #${number}`, { number, event, repo: r });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_github_issue_get",
    {
      title: "Get Issue",
      description: "Get details of a GitHub issue.",
      inputSchema: {
        number: z.number().int().positive(),
        repo: z.string().optional().describe("owner/repo, defaults to inferred from git remote")
      }
    },
    async ({ number, repo }) => {
      try {
        const r = repo ?? gh.inferRepo(workspaceRoot);
        const issue = gh.getIssue(number, r);
        return success(JSON.stringify(issue, null, 2), issue as unknown as Record<string, unknown>);
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_github_issue_list",
    {
      title: "List Issues",
      description: "List GitHub issues with filters.",
      inputSchema: {
        repo: z.string().optional().describe("owner/repo, defaults to inferred from git remote"),
        state: z.enum(["open", "closed", "all"]).default("open"),
        limit: z.number().int().min(1).max(100).default(30),
        author: z.string().optional(),
        labels: z.string().optional().describe("comma-separated")
      }
    },
    async ({ repo, state, limit, author, labels }) => {
      try {
        const r = repo ?? gh.inferRepo(workspaceRoot);
        const issues = gh.listIssues({ repo: r, state, limit, author, labels: labels?.split(",") });
        return success(JSON.stringify(issues, null, 2), { count: issues.length, issues: issues as unknown as Record<string, unknown>[] });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_github_comment",
    {
      title: "Create GitHub Comment",
      description: "Create a comment on a GitHub issue or pull request.",
      inputSchema: {
        number: z.number().int().positive(),
        body: z.string().min(1),
        repo: z.string().optional().describe("owner/repo, defaults to inferred from git remote")
      }
    },
    async ({ number, body, repo }) => {
      try {
        const r = repo ?? gh.inferRepo(workspaceRoot);
        gh.createComment(number, body, r);
        return success(`Comment posted on #${number}`, { number, repo: r });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_github_search",
    {
      title: "Search GitHub Code",
      description: "Search code across GitHub repositories.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10)
      }
    },
    async ({ query, limit }) => {
      try {
        const results = gh.searchCode(query, limit);
        return success(JSON.stringify(results, null, 2), { count: results.length, results: results as unknown as Record<string, unknown>[] });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_github_api",
    {
      title: "GitHub API",
      description: "Raw GitHub API GET request via gh CLI.",
      inputSchema: {
        endpoint: z.string().min(1).describe("e.g. /repos/owner/repo/pulls")
      }
    },
    async ({ endpoint }) => {
      try {
        const data = gh.apiRequest(endpoint);
        return success(JSON.stringify(data, null, 2), { endpoint });
      } catch (error) { return failure(error); }
    }
  );

  // ── /GitHub tools ───────────────────────────────────────────────
}
