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
  const server = new McpServer({ name: "oracle", version: VERSION });

  // Use OrchestratorFactory to create adapters with MCP support
  const orchestrator = new OrchestratorFactory(workspaceRoot, homeDir);
  const memory = await orchestrator.createMemoryAdapter();

  // The agentic loop (oracle_agent) needs a tool-capable provider; wire it when
  // the configured provider supports tool use, otherwise leave a clear reason.
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
    agent,
    agentUnavailableReason
  });
  return server;
}
