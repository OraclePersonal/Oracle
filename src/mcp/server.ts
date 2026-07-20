import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ProjectConfig } from "../config/project.js";
import type { ConsultService } from "../core/consult.js";
import { OracleError, serializeOracleError } from "../errors.js";
import { isOracleError } from "./oracleErrors.js";
import { checkProvider } from "../providers/factory.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { OracleRegistry } from "../oracles/registry.js";
import { ProfileStore } from "../identity/profile.js";
import type { MemoryPort } from "../orchestrator/ports.js";
import { listDocs, searchDocs, addDoc, removeDoc } from "../docs/reader.js";
import { getConversationContext, recordSelfLog } from "../core/selfMemory.js";
import { loadSoul } from "../core/souls.js";
import { buildWiki, getWikiPage, listWikiTopics } from "../wiki/compile.js";
import { webSearchWithTrace } from "../web/search.js";
import { fetchUrl } from "../web/fetchUrl.js";
import { agentqlExtract } from "../web/providers/agentql.js";
import { SEARCH_PROVIDERS, FETCH_PROVIDERS } from "../web/types.js";
import type { AgentService } from "../agent/service.js";

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
  providerChecks?: typeof checkProvider;
  /** Present only when the configured provider supports agentic tool use. */
  agent?: AgentService;
  /** Why the agent is unavailable, surfaced by oracle_agent when agent is undefined. */
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
  let serialized: Record<string, any>;
  if (isOracleError(error)) {
    serialized = error.toJSON();
  } else if (error instanceof OracleError) {
    serialized = serializeOracleError(error);
  } else {
    serialized = { error: error instanceof Error ? error.message : String(error) };
  }
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
  providerChecks = checkProvider,
  agent,
  agentUnavailableReason,
  soulsDir = path.join(os.homedir(), ".oracle", "souls")
}: OracleServerDependencies & { soulsDir?: string }): void {
  server.registerTool(
    "oracle_agent",
    {
      title: "Run Oracle Agent",
      description:
        "Autonomously carry out a coding task in the workspace: Oracle reads/writes/edits files, searches the codebase, and runs shell commands (build, tests, git) in a tool-use loop until the task is done. Use for 'implement X', 'fix the failing test', 'refactor Y'. Set readOnly to investigate without changing anything. Requires an agent-capable provider (anthropic or opencode).",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(50000)
          .describe("The task to carry out, e.g. 'add a --verbose flag to the CLI and update the README'"),
        readOnly: z
          .boolean()
          .optional()
          .describe("Investigate only — disables write_file/edit_file/bash (default false)"),
        maxSteps: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max agent turns before stopping (default 20)")
      }
    },
    async ({ prompt, readOnly, maxSteps }, extra) => {
      try {
        if (!agent) {
          throw new OracleError(
            "ORACLE_AGENT_UNAVAILABLE",
            "The agent is not available with the configured provider.",
            agentUnavailableReason ??
              "Set provider to 'anthropic' or 'opencode' in .oracle/config.json."
          );
        }
        const progressToken = extra._meta?.progressToken;
        const result = await agent.run({
          prompt,
          workspaceRoot,
          model: config.model,
          readOnly,
          maxSteps,
          onStep: async (step) => {
            if (progressToken === undefined) return;
            await extra.sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: step.turn,
                message:
                  step.toolsUsed.length > 0
                    ? `Turn ${step.turn}: ${step.toolsUsed.join(", ")}`
                    : `Turn ${step.turn}: finalizing`
              }
            });
          }
        });
        return success(result.finalText, {
          finalText: result.finalText,
          steps: result.steps,
          stoppedOnLimit: result.stoppedOnLimit,
          turns: result.steps.length,
          usage: result.usage,
          readOnly: readOnly ?? false
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
        oracle: z
          .string()
          .optional()
          .describe("Oracle profile name (e.g. 'coding', 'security'). Auto-scopes memory and uses profile's soul"),
        soul: z
          .string()
          .optional()
          .describe("Soul prompt name (e.g. 'engineer', 'philosopher'). Defaults to 'default'"),
        context: z.string().optional().describe("Additional context: code snippets, error messages, what you've tried"),
        files: z.array(z.string()).optional().describe("File paths or glob patterns to read and include, when the question needs real code (e.g. ['src/**/*.ts'])"),
        conversationId: z.string().optional().describe("Stable id for this exchange — pass the same value across multiple oracle_ask calls so Oracle recalls what it already said"),
        include_docs: z.boolean().optional().describe("Search .oracle/docs/ for relevant documentation and include as context"),
        doc_search: z.string().optional().describe("Specific doc query (defaults to using the question itself)")
      }
    },
    async ({ question, oracle, soul, context, files, conversationId, include_docs, doc_search }) => {
      try {
        let agentScope = oracle;
        const soulName = soul ?? (oracle ? oracle : "default");
        const soulPrompt = await loadSoul(soulName, soulsDir);
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

        // Inject memory context if oracle profile has memory enabled
        let memoryCtx = "";
        if (agentScope) {
          const oracleProfile = await oracles.getOracle(agentScope);
          if (oracleProfile?.memory) {
            const memoryEntries = await memory.recall({ agent: agentScope, limit: 5 });
            if (memoryEntries.length > 0) {
              const memoryBlock = memoryEntries
                .map((e) => `[${e.type.toUpperCase()}] ${e.content.slice(0, 200)}`)
                .join("\n\n");
              memoryCtx = `\n\n## Memory Context (agent: ${agentScope})\n${memoryBlock}`;
            }
          }
        }

        const prompt = `${ctxBlock}${memoryCtx}\n\n## Question\n${question}`;
        const systemPrompt = `${soulPrompt}\n\nAnswer concisely and directly. If you don't know, say so.`;
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

        // Auto-save insight to memory if oracle profile has memory enabled
        if (agentScope) {
          const oracleProfile = await oracles.getOracle(agentScope);
          if (oracleProfile?.memory && result.status === "completed") {
            await memory.remember(agentScope, "insight", result.output.slice(0, 500), {
              tags: ["ask", "qa"],
              importance: 0.5
            });
          }
        }

        return success(result.output, {
          soul: soulName,
          sessionId: result.sessionId,
          filesIncluded: result.files.length,
          agentScope
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
      description: "Show memory entries from the .oracle-memory store, filtered by agent, type, and recency.",
      inputSchema: {
        agent: z
          .string()
          .optional()
          .describe("Agent name to filter by (your name or oracle profile name)"),
        type: z
          .enum(["fact", "insight", "chunk", "working"])
          .optional()
          .describe("Memory type: fact (durable), insight (analysis), chunk (code), working (session temp)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(10)
          .describe("Max entries to return")
      }
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
      description: "Full-text search over memory contents by keyword, returning ranked results.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(500)
          .describe("Search keyword or phrase"),
        agent: z
          .string()
          .optional()
          .describe("Filter to a specific agent's memory"),
        type: z
          .enum(["fact", "insight", "chunk", "working"])
          .optional()
          .describe("Filter by memory type"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(20)
          .describe("Max results to return")
      }
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
}
