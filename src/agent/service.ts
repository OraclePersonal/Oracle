import { defaultAgentTools } from "./tools.js";
import { runAgentLoop, type AgentRunResult, type AgentStep } from "./loop.js";
import type { AgentProvider, AgentTool } from "./types.js";
import { McpClientManager } from "../orchestrator/mcp-client-manager.js";
import { loadProjectConfig } from "../config/project.js";
import { SkillRegistry } from "../skills/registry.js";
import os from "node:os";
import path from "node:path";

const DEFAULT_AGENT_SYSTEM = [
  "You are Oracle, an autonomous coding agent operating directly inside the user's project.",
  "You can read and write files and search the codebase via the provided tools — there is no shell",
  "execution; every tool is confined to files inside the workspace. Work in small, verifiable steps:",
  "inspect before you change, make focused edits. Prefer editing existing files over rewriting them.",
  "When the task is complete, stop calling tools and give a concise summary of what you changed and why.",
  "Never touch paths outside the workspace. Do not print secrets.",
].join(" ");

export interface AgentRequest {
  prompt: string;
  workspaceRoot: string;
  model: string;
  /** Analysis-only: disables write_file/edit_file. */
  readOnly?: boolean;
  /** Extra guidance prepended to the default agent system prompt. */
  systemPrefix?: string;
  /** Skill name to apply (review, debug, security, etc.). */
  skill?: string;
  maxSteps?: number;
  onStep?: (step: AgentStep) => void | Promise<void>;
  /** Override the toolset (mainly for tests). */
  tools?: AgentTool[];
}

/**
 * AgentService drives Oracle's agentic loop: it wires the default,
 * workspace-confined filesystem toolset to a tool-capable provider and runs
 * the loop to completion.
 */
export class AgentService {
  constructor(private readonly provider: AgentProvider) {}

  async run(request: AgentRequest): Promise<AgentRunResult> {
    const readOnly = request.readOnly ?? false;
    let allTools = request.tools ?? defaultAgentTools();

    // Discover MCP tools from configured external servers
    if (!request.tools) {
      try {
        const projectConfig = await loadProjectConfig(request.workspaceRoot);
        if (projectConfig.mcpServers?.length) {
          const mgr = new McpClientManager(projectConfig.mcpServers);
          try {
            const mcpTools = await mgr.connectAll();
            if (mcpTools.length) allTools = [...allTools, ...mcpTools];
          } finally {
            await mgr.disconnectAll();
          }
        }
      } catch {
        // Non-fatal: run with local tools only if config loading fails
      }
    }

    // In read-only mode, drop mutating tools entirely so the model can't even try.
    const tools = readOnly ? allTools.filter((t) => !t.mutating) : allTools;

    let system = request.systemPrefix
      ? `${request.systemPrefix}\n\n${DEFAULT_AGENT_SYSTEM}`
      : DEFAULT_AGENT_SYSTEM;

    // Compose skill into system prompt if specified
    if (request.skill) {
      try {
        const skillRegistry = new SkillRegistry(path.join(os.homedir(), ".oracle"));
        await skillRegistry.load();
        system = skillRegistry.compose(request.skill, system);
      } catch {
        // Non-fatal: run with base system prompt if skill loading fails
      }
    }

    return runAgentLoop({
      provider: this.provider,
      model: request.model,
      system,
      prompt: request.prompt,
      tools,
      context: { workspaceRoot: request.workspaceRoot, readOnly },
      maxSteps: request.maxSteps,
      onStep: request.onStep,
    });
  }
}

export { DEFAULT_AGENT_SYSTEM };
