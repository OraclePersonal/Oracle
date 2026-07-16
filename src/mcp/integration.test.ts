import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_PROJECT_CONFIG } from "../config/project.js";
import { ConsultService } from "../core/consult.js";
import type { Provider } from "../providers/provider.js";
import { FileSessionStore } from "../session/store.js";
import { SkillRegistry } from "../skills/registry.js";
import { OracleRegistry } from "../oracles/registry.js";
import { MemoryAdapter } from "../memory/adapter.js";
import { ProfileStore } from "../identity/profile.js";
import { registerOracleTools } from "./server.js";

const provider: Provider = {
  id: "codex",
  async run(request) {
    return { text: `ANSWER: ${request.userPrompt}`, usage: {} };
  }
};

let root: string;
let client: Client;
let server: McpServer;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-mcp-test-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "sample.ts"), "export const answer = 42;", "utf8");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server = new McpServer({ name: "oracle-test", version: "1.0.0" });
  const skills = new SkillRegistry(root, path.join(root, ".oracle", "skills"));
  await skills.load();
  const oracles = new OracleRegistry(root, root);
  registerOracleTools({
    server,
    service: new ConsultService(provider, new FileSessionStore(path.join(root, ".sessions"))),
    config: { ...DEFAULT_PROJECT_CONFIG, include: ["src/**/*.ts"], exclude: [] },
    workspaceRoot: root,
    providerId: "codex",
    skills,
    oracles,
    memory: new MemoryAdapter(root),
    profile: new ProfileStore(root),
    providerChecks: async () => [{ name: "provider", ok: true, detail: "test" }]
  });
  client = new Client({ name: "oracle-test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await server.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("Oracle MCP tools", () => {
  test("lists all focused tools", async () => {
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(tools).toContain("oracle_consult");
    expect(tools).toContain("oracle_doctor");
    expect(tools).toContain("oracle_skills");
    expect(tools).toContain("oracle_oracle_list");
    expect(tools).toContain("oracle_oracle_register");
    expect(tools).toContain("oracle_memory_list");
    expect(tools).toContain("oracle_memory_clear");
    expect(tools).toContain("oracle_identity_show");
    expect(tools).toContain("oracle_identity_setup");
    expect(tools).toContain("oracle_persona_set");
  });

  test("consults, lists, retrieves, and diagnoses", async () => {
    const consultation = await client.callTool({
      name: "oracle_consult",
      arguments: { prompt: "Review", skill: "debug" }
    });
    expect(consultation.isError).not.toBe(true);
    expect(consultation.structuredContent).toMatchObject({
      status: "completed",
      provider: "codex",
      preset: "debug",
      filesIncluded: 1
    });

    const sessions = await client.callTool({ name: "oracle_sessions", arguments: { limit: 1 } });
    const sessionId = (sessions.structuredContent as { sessions: Array<{ sessionId: string }> }).sessions[0].sessionId;
    const session = await client.callTool({ name: "oracle_session_get", arguments: { sessionId } });
    expect(session.isError).not.toBe(true);

    const doctor = await client.callTool({ name: "oracle_doctor", arguments: {} });
    const expectedHealthy = Number.parseInt(process.versions.node.split(".")[0], 10) >= 24;
    expect(doctor.structuredContent).toMatchObject({ healthy: expectedHealthy });
    expect((doctor.structuredContent as { checks: Array<{ name: string }> }).checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "provider" })])
    );
  });
});
