import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadProjectConfig } from "../config/project.js";
import { ConsultService } from "../core/consult.js";
import { createProvider } from "../providers/factory.js";
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

  registerOracleTools({
    server,
    service: new ConsultService(createProvider(config.provider)),
    config,
    workspaceRoot,
    providerId: config.provider,
    skills,
    oracles,
    memory,
    profile: new ProfileStore(homeDir)
  });
  return server;
}
