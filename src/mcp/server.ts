import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ProjectConfig } from "../config/project.js";
import { DEFAULT_SYSTEM_PROMPT } from "../context/bundle.js";
import type { ConsultService } from "../core/consult.js";
import { OracleError, serializeOracleError } from "../errors.js";
import { checkProvider } from "../providers/factory.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { OracleRegistry } from "../oracles/registry.js";
import { ProfileStore } from "../identity/profile.js";
import type { MessageKind } from "../peer/mesh.js";
import type { MemoryPort, MessagesPort } from "../orchestrator/ports.js";
import type { PRFile } from "../github/types.js";
import * as gh from "../github/gh.js";
import { listDocs, searchDocs } from "../docs/reader.js";

const SOUL_CACHE = new Map<string, string>();

async function loadSoul(name: string, dir: string): Promise<string> {
  const key = `${dir}:${name}`;
  const cached = SOUL_CACHE.get(key);
  if (cached) return cached;
  const [file, defaultFile] = [`${name}.md`, "default.md"];
  for (const f of [file, defaultFile]) {
    try {
      const content = await fs.readFile(path.join(dir, f), "utf-8");
      SOUL_CACHE.set(key, content);
      return content;
    } catch {}
  }
  // ponytail: no soul dir or file — return a minimal fallback prompt
  return "You are Oracle, a senior engineer. Answer concisely and directly.";
}

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
  messages: MessagesPort;
  providerChecks?: typeof checkProvider;
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

const MESSAGE_KINDS = [
  "message", "note", "question", "review-request", "review-result",
  "proposal", "proposal-response", "wake", "end", "task",
  "task-assign", "task-update", "task-complete", "task-fail"
] as const;

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
  soulsDir = path.join(os.homedir(), ".oracle", "souls")
}: OracleServerDependencies & { soulsDir?: string }): void {
  server.registerTool(
    "oracle_consult",
    {
      title: "Consult Oracle",
      description: "Analyze project files with a focused engineering skill.",
      inputSchema: {
        prompt: z.string().min(1),
        skill: z.string().optional(),
        files: z.array(z.string()).optional(),
        previousSessionId: z.string().optional()
      }
    },
    async ({ prompt, skill, files, previousSessionId }, extra) => {
      try {
        const progressToken = extra._meta?.progressToken;
        const progress = async (value: number, message: string) => {
          if (progressToken === undefined) return;
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress: value, total: 3, message }
          });
        };
        await progress(1, "Resolving and validating project files");
        const skillName = skill ?? "review";
        const selected = skills.get(skillName);
        if (!selected) throw new OracleError("ORACLE_INVALID_REQUEST", `Unknown skill: ${skillName}`, `Available: ${skills.names().join(", ")}`);
        const patterns = [...(files ?? config.include), ...config.exclude.map((item) => `!${item}`)];
        await progress(2, "Consulting the configured provider");
        let previousResponseId: string | undefined;
        if (previousSessionId) {
          const prev = await service.session(previousSessionId);
          previousResponseId = prev?.responseId;
        }
        const basePrompt = skills.compose(skillName, DEFAULT_SYSTEM_PROMPT);
        const personalCtx = await profile.buildPersonalContext();
        const systemPrompt = personalCtx ? `${personalCtx}\n\n${basePrompt}` : basePrompt;
        const result = await service.consult({
          prompt,
          preset: skillName,
          provider: providerId,
          files: patterns,
          model: selected.model ?? config.model,
          cwd: workspaceRoot,
          maxFileSizeBytes: config.maxFileSizeBytes,
          maxInputBytes: config.maxInputBytes,
          previousResponseId,
          systemPrompt
        });
        await progress(3, "Session persisted");
        return success(result.output, {
          ...result,
          provider: providerId,
          preset: skillName,
          filesIncluded: result.files.length
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
      description: "Ask Oracle a question. Use when you're unsure, need a second opinion, or hit something outside your knowledge. Oracle answers with its configured soul prompt.",
      inputSchema: {
        question: z.string().min(1).describe("Your question or what you're stuck on"),
        soul: z.string().optional().describe("Soul prompt name (e.g. 'engineer', 'philosopher'). Defaults to 'default'"),
        context: z.string().optional().describe("Additional context: code snippets, error messages, what you've tried"),
        include_docs: z.boolean().optional().describe("Search .oracle/docs/ for relevant documentation and include as context"),
        doc_search: z.string().optional().describe("Specific doc query (defaults to using the question itself)")
      }
    },
    async ({ question, soul, context, include_docs, doc_search }) => {
      try {
        const soulName = soul ?? "default";
        const soulPrompt = await loadSoul(soulName, soulsDir);
        let ctxBlock = context ? `\n\n## Context from the asking agent\n${context}` : "";

        // Include relevant docs from .oracle/docs/
        if (include_docs) {
          const docQuery = doc_search ?? question;
          const matched = await searchDocs(workspaceRoot, docQuery);
          if (matched.length > 0) {
            const docsBlock = matched
              .slice(0, 5)
              .map((d) => `### ${d.name}\n${d.content.slice(0, 3000)}`)
              .join("\n\n");
            ctxBlock += `\n\n## Documentation from .oracle/docs/\n${docsBlock}\n\n(Match: "${docQuery}")`;
          }
        }

        const prompt = `${ctxBlock}\n\n## Question\n${question}`;
        const systemPrompt = `${soulPrompt}\n\nAnswer concisely and directly. If you don't know, say so.`;
        const result = await service.consult({
          prompt,
          preset: "review",
          provider: providerId,
          files: [],
          model: config.model,
          cwd: workspaceRoot,
          maxFileSizeBytes: 0,
          maxInputBytes: config.maxInputBytes,
          systemPrompt,
          allowEmptyFiles: true,
        });
        return success(result.output, {
          soul: soulName,
          sessionId: result.sessionId
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
        const entries = await memory.recall({ type: type as any, agent: agent ?? undefined, limit });
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
      description: "Search .oracle/docs/ files by keyword.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).default(5),
      }
    },
    async ({ query, limit }) => {
      try {
        const docs = await searchDocs(workspaceRoot, query);
        const results = docs.slice(0, limit).map((d) => ({
          name: d.name,
          snippet: d.content.slice(0, 500),
          size: d.size,
        }));
        return success(JSON.stringify(results, null, 2), { count: results.length, results });
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

  server.registerTool(
    "oracle_peer_send",
    {
      title: "Send Peer Message",
      description: "Send a message to another agent (or * for broadcast) via the oracle-messages mesh.",
      inputSchema: {
        to: z.string().min(1),
        body: z.string().min(1),
        from: z.string().default("oracle"),
        kind: z.enum(MESSAGE_KINDS).default("message"),
        subject: z.string().optional(),
        parentId: z.string().optional()
      }
    },
    async ({ to, body, from, kind, subject, parentId }) => {
      try {
        const msg = await messages.send(from, to, body, kind as MessageKind, { subject, parentId });
        return success(`Sent: ${msg.id}`, { message: msg });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_peer_broadcast",
    {
      title: "Broadcast Peer Message",
      description: "Broadcast a message to all agents via the oracle-messages mesh.",
      inputSchema: {
        body: z.string().min(1),
        from: z.string().default("oracle"),
        kind: z.enum(MESSAGE_KINDS).default("note"),
        subject: z.string().optional()
      }
    },
    async ({ body, from, kind, subject }) => {
      try {
        const msg = await messages.broadcast(from, body, kind as MessageKind, { subject });
        return success(`Broadcast: ${msg.id}`, { message: msg });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_peer_list",
    {
      title: "List Peer Messages",
      description: "List messages from the oracle-messages mesh.",
      inputSchema: {
        agent: z.string().optional(),
        kind: z.enum(MESSAGE_KINDS).optional(),
        limit: z.number().int().min(1).max(100).default(20)
      }
    },
    async ({ agent, kind, limit }) => {
      try {
        const msgs = await messages.getMessages({ agent, kind: kind as MessageKind | undefined, limit });
        return success(JSON.stringify(msgs, null, 2), { messages: msgs });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_peer_unread",
    {
      title: "Get Unread Peer Messages",
      description: "Get unread messages for an agent, optionally since a message id.",
      inputSchema: {
        agent: z.string().min(1),
        sinceId: z.string().optional()
      }
    },
    async ({ agent, sinceId }) => {
      try {
        const msgs = await messages.getUnread(agent, sinceId);
        return success(JSON.stringify(msgs, null, 2), { messages: msgs });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_peer_thread",
    {
      title: "Get Peer Message Thread",
      description: "Get all messages belonging to a thread by root message id.",
      inputSchema: { rootId: z.string().min(1) }
    },
    async ({ rootId }) => {
      try {
        const msgs = await messages.getThread(rootId);
        return success(JSON.stringify(msgs, null, 2), { messages: msgs });
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
