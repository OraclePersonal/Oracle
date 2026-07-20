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
import { AgentService } from "../agent/service.js";
import type { AgentProvider, AgentTurn } from "../agent/types.js";
import { registerOracleTools } from "./server.js";

const provider: Provider = {
  id: "codex",
  async run(request) {
    return { text: `ANSWER: ${request.userPrompt}`, usage: {} };
  }
};

/** Scripted agent provider: write a file, then finish. */
const agentProvider: AgentProvider = {
  id: "scripted",
  calls: 0,
  async runAgentTurn(): Promise<AgentTurn> {
    const self = agentProvider as AgentProvider & { calls: number };
    self.calls += 1;
    if (self.calls === 1) {
      return {
        message: {
          role: "assistant",
          text: "Creating the file.",
          toolCalls: [{ id: "c1", name: "write_file", input: { path: "agent-output.txt", content: "made by agent" } }],
        },
      };
    }
    return { message: { role: "assistant", text: "Done.", toolCalls: [] } };
  },
} as AgentProvider & { calls: number };

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
    providerChecks: async () => [{ name: "provider", ok: true, detail: "test" }],
    agent: new AgentService(agentProvider)
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
    expect(tools).toContain("oracle_ask");
    expect(tools).toContain("oracle_agent");
    expect(tools).not.toContain("oracle_consult");
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

  test("asks with files, lists, retrieves, and diagnoses", async () => {
    const consultation = await client.callTool({
      name: "oracle_ask",
      arguments: { question: "Review", files: ["src/**/*.ts"] }
    });
    expect(consultation.isError).not.toBe(true);
    expect(consultation.structuredContent).toMatchObject({
      soul: "default",
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

  test("oracle_agent runs the tool-use loop and writes a file in the workspace", async () => {
    const run = await client.callTool({
      name: "oracle_agent",
      arguments: { prompt: "create agent-output.txt" }
    });
    expect(run.isError).not.toBe(true);
    expect(run.structuredContent).toMatchObject({
      finalText: "Done.",
      turns: 2,
      stoppedOnLimit: false
    });
    // The agent actually wrote the file via the write_file tool.
    const written = await fs.readFile(path.join(root, "agent-output.txt"), "utf8");
    expect(written).toBe("made by agent");
  });

  test("identity_setup accepts a single freeform string as well as an array for list fields", async () => {
    // Found via real usage: preferences/habits/goals are stored as arrays,
    // but a single descriptive string is the natural first thing an agent
    // tries — it must not hard-fail, and should split into discrete items
    // rather than being stored as one giant entry.
    const stringForm = await client.callTool({
      name: "oracle_identity_setup",
      arguments: { name: "string-agent", preferences: "prefers concise diffs, likes tabs" }
    });
    expect(stringForm.isError).not.toBe(true);

    const shown = await client.callTool({ name: "oracle_identity_show", arguments: {} });
    expect((shown.structuredContent as { identity: { preferences: string[] } }).identity.preferences).toEqual([
      "prefers concise diffs",
      "likes tabs"
    ]);

    const arrayForm = await client.callTool({
      name: "oracle_identity_setup",
      arguments: { name: "array-agent", goals: ["ship feature X", "fix bug Y"] }
    });
    expect(arrayForm.isError).not.toBe(true);

    const shownArray = await client.callTool({ name: "oracle_identity_show", arguments: {} });
    expect((shownArray.structuredContent as { identity: { goals: string[] } }).identity.goals).toEqual([
      "ship feature X",
      "fix bug Y"
    ]);
  });
});
