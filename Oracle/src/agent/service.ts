import { defaultAgentTools } from "./tools.js";
import { runAgentLoop, type AgentRunResult, type AgentStep } from "./loop.js";
import type { AgentProvider, AgentTool } from "./types.js";

const DEFAULT_AGENT_SYSTEM = [
  "You are Oracle, an autonomous coding agent operating directly inside the user's project.",
  "You can read and write files, search the codebase, and run shell commands via the provided tools.",
  "Work in small, verifiable steps: inspect before you change, make focused edits, and run the",
  "project's build/tests to confirm your work. Prefer editing existing files over rewriting them.",
  "When the task is complete, stop calling tools and give a concise summary of what you changed and why.",
  "Never touch paths outside the workspace. Do not print secrets.",
].join(" ");

export interface AgentRequest {
  prompt: string;
  workspaceRoot: string;
  model: string;
  /** Analysis-only: disables write_file/edit_file/bash. */
  readOnly?: boolean;
  /** Extra guidance prepended to the default agent system prompt. */
  systemPrefix?: string;
  maxSteps?: number;
  onStep?: (step: AgentStep) => void | Promise<void>;
  /** Override the toolset (mainly for tests). */
  tools?: AgentTool[];
}

/**
 * AgentService drives Oracle's agentic loop: it wires the default filesystem +
 * shell toolset to a tool-capable provider and runs the loop to completion.
 */
export class AgentService {
  constructor(private readonly provider: AgentProvider) {}

  async run(request: AgentRequest): Promise<AgentRunResult> {
    const readOnly = request.readOnly ?? false;
    const allTools = request.tools ?? defaultAgentTools();
    // In read-only mode, drop mutating tools entirely so the model can't even try.
    const tools = readOnly ? allTools.filter((t) => !t.mutating) : allTools;

    const system = request.systemPrefix
      ? `${request.systemPrefix}\n\n${DEFAULT_AGENT_SYSTEM}`
      : DEFAULT_AGENT_SYSTEM;

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
