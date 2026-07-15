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
import { composePresetSystemPrompt, PRESET_NAMES, type PresetName } from "../presets.js";

interface OracleServerDependencies {
  server: McpServer;
  service: ConsultService;
  config: ProjectConfig;
  workspaceRoot: string;
  providerId: string;
  providerChecks?: typeof checkProvider;
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
  providerChecks = checkProvider
}: OracleServerDependencies): void {
  server.registerTool(
    "oracle_consult",
    {
      title: "Consult Oracle",
      description: "Analyze project files with a focused engineering preset.",
      inputSchema: {
        prompt: z.string().min(1),
        preset: z.enum(PRESET_NAMES).default("review"),
        files: z.array(z.string()).optional()
      }
    },
    async ({ prompt, preset, files }, extra) => {
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
        const patterns = [...(files ?? config.include), ...config.exclude.map((item) => `!${item}`)];
        await progress(2, "Consulting the configured provider");
        const result = await service.consult({
          prompt,
          preset,
          provider: providerId,
          files: patterns,
          model: config.model,
          cwd: workspaceRoot,
          maxFileSizeBytes: config.maxFileSizeBytes,
          maxInputBytes: config.maxInputBytes,
          systemPrompt: composePresetSystemPrompt(preset as PresetName, DEFAULT_SYSTEM_PROMPT)
        });
        await progress(3, "Session persisted");
        return success(result.output, {
          ...result,
          provider: providerId,
          preset,
          filesIncluded: result.files.length
        });
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
    "oracle_doctor",
    {
      title: "Check Oracle",
      description: "Check project configuration and provider readiness.",
      inputSchema: {}
    },
    async () => {
      try {
        const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
        const sessionProbe = await fs.mkdtemp(path.join(os.tmpdir(), "mini-oracle-doctor-"));
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
