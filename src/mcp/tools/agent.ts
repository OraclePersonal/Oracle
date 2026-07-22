import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentService } from "../../agent/service.js";
import { CheckpointStore } from "../../agent/checkpoint.js";
import type { SkillRegistry } from "../../skills/registry.js";
import path from "node:path";
import os from "node:os";
import type { ProjectConfig } from "../../config/project.js";
import { OracleError, serializeOracleError } from "../../errors.js";

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

export function registerAgentTools(
  server: McpServer,
  deps: {
    config: ProjectConfig;
    workspaceRoot: string;
    skills: SkillRegistry;
    agent?: AgentService;
    agentUnavailableReason?: string;
  }
): void {
  server.registerTool(
    "oracle_agent",
    {
      title: "Run Oracle Agent",
      description: "Autonomously carry out a coding task in the workspace with a tool-use loop.",
      inputSchema: {
        prompt: z.string().min(1).max(50000),
        readOnly: z.boolean().optional(),
        skill: z.string().optional().describe("Skill to apply (review, debug, security, architecture, tests)"),
        maxSteps: z.number().int().min(1).max(50).optional(),
        resumeId: z.string().optional().describe("Checkpoint id to resume from a previous interrupted run. Returns checkpointId on each run for this purpose.")
      }
    },
    async ({ prompt, readOnly, skill, maxSteps, resumeId }) => {
      try {
        if (!deps.agent) {
          throw new OracleError(
            "ORACLE_AGENT_UNAVAILABLE",
            "The agent is not available with the configured provider.",
            deps.agentUnavailableReason ?? "Set provider to 'anthropic' or 'opencode' in .oracle/config.json."
          );
        }
        const result = await deps.agent.run({ prompt, workspaceRoot: deps.workspaceRoot, model: deps.config.model, readOnly, skill, maxSteps, resumeId });
        return success(result.finalText, {
          finalText: result.finalText,
          steps: result.steps,
          stoppedOnLimit: result.stoppedOnLimit,
          turns: result.steps.length,
          usage: result.usage,
          readOnly: readOnly ?? false,
          skill: skill ?? undefined,
          checkpointId: result.checkpointId ?? null
        });
      } catch (error) {
        return failure(error);
      }
    }
  );

  // ── Checkpoint management tools ──────────────────────────────────

  const oracleDir = process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle");
  const checkpointStore = new CheckpointStore(oracleDir);

  server.registerTool(
    "oracle_agent_checkpoints",
    {
      title: "List Agent Checkpoints",
      description:
        "List saved agent loop checkpoints. A checkpoint is created after every tool-calling turn when oracle_agent runs. " +
        "If an agent run was interrupted (process crash, timeout), pass the checkpoint id as resumeId to oracle_agent to continue from where it left off.",
      inputSchema: {}
    },
    async () => {
      try {
        const list = await checkpointStore.list();
        const lines = list.length
          ? list.map((c) => `${c.id} (${c.updatedAt})`).join("\n")
          : "No checkpoints found.";
        return success(lines, { count: list.length, checkpoints: list });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_agent_checkpoint_delete",
    {
      title: "Delete Agent Checkpoint",
      description: "Delete a saved checkpoint by id. Use when a checkpoint is no longer needed.",
      inputSchema: { id: z.string().min(1) }
    },
    async ({ id }) => {
      try {
        const removed = await checkpointStore.delete(id);
        return success(removed ? `Deleted checkpoint ${id}.` : `Checkpoint not found: ${id}.`, { removed });
      } catch (error) { return failure(error); }
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
        const list = deps.skills.list().map((s) => ({
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
}
