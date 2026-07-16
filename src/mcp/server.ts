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
import { SkillRegistry } from "../skills/registry.js";
import { OracleRegistry } from "../oracles/registry.js";
import { MemoryAdapter } from "../memory/adapter.js";
import { ProfileStore } from "../identity/profile.js";
import { MessagesAdapter, type MessageKind } from "../peer/mesh.js";

interface OracleServerDependencies {
  server: McpServer;
  service: ConsultService;
  config: ProjectConfig;
  workspaceRoot: string;
  providerId: string;
  skills: SkillRegistry;
  oracles: OracleRegistry;
  memory: MemoryAdapter;
  profile: ProfileStore;
  messages: MessagesAdapter;
  providerChecks?: typeof checkProvider;
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
  providerChecks = checkProvider
}: OracleServerDependencies): void {
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
        const entries = await memory.recall(type as any, agent ?? undefined, limit);
        return success(JSON.stringify(entries, null, 2), { entries });
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
        preferences: z.array(z.string()).optional(),
        habits: z.array(z.string()).optional(),
        goals: z.array(z.string()).optional()
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
}
