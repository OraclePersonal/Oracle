import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadProjectConfig } from "../config/project.js";
import { ConsultService } from "../core/consult.js";
import { createProvider, createAgentProvider } from "../providers/factory.js";
import { AgentService } from "../agent/service.js";
import { SkillRegistry } from "../skills/registry.js";
import { OracleRegistry } from "../oracles/registry.js";
import { ProfileStore } from "../identity/profile.js";
import { MessageStore } from "../messaging/store.js";
import { AgentRegistry } from "../messaging/registry.js";
import { TaskStore } from "../tasks/store.js";
import { MESSAGING_INSTRUCTIONS } from "./messagingTools.js";
import { TASK_INSTRUCTIONS } from "./taskTools.js";
import { OrchestratorFactory } from "../orchestrator/factory.js";
import { VERSION } from "../version.js";
import { registerOracleTools } from "./server.js";

export async function createOracleMcpServer(
  workspace = process.env.ORACLE_WORKSPACE_ROOT ?? process.cwd()
): Promise<McpServer> {
  const workspaceRoot = path.resolve(workspace);
  const config = await loadProjectConfig(workspaceRoot);
  const homeDir = process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle");
  const skills = new SkillRegistry(homeDir, path.join(workspaceRoot, ".oracle", "skills"));
  await skills.load();
  const oracles = new OracleRegistry(homeDir, workspaceRoot);
  const server = new McpServer(
    { name: "oracle", version: VERSION },
    { instructions: `${MESSAGING_INSTRUCTIONS} ${TASK_INSTRUCTIONS}` }
  );

  // Use OrchestratorFactory to create adapters with MCP support
  const orchestrator = new OrchestratorFactory(workspaceRoot, homeDir);
  const memory = await orchestrator.createMemoryAdapter();

  // Start periodic background maintenance.
  // Default: consolidate + prune+promote every 1h,
  //          graph prune every 2h,
  //          LLM reflection every 4h (if ANTHROPIC_API_KEY is set).
  memory.startAutoMaintenance?.();
  console.log("[oracle-mcp] background memory maintenance started (1h interval, graph prune 2h, reflection 4h)");

  let agent: AgentService | undefined;
  let agentUnavailableReason: string | undefined;
  try {
    agent = new AgentService(createAgentProvider(config.provider));
  } catch (error) {
    agentUnavailableReason = error instanceof Error ? error.message : String(error);
  }

  registerOracleTools({
    server,
    service: new ConsultService(createProvider(config.provider)),
    config,
    workspaceRoot,
    providerId: config.provider,
    skills,
    oracles,
    memory,
    profile: new ProfileStore(homeDir),
    messages: new MessageStore(homeDir),
    agentRegistry: new AgentRegistry(homeDir),
    tasks: new TaskStore(homeDir),
    agent,
    agentUnavailableReason
  });
  return server;
}
