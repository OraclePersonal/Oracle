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
import { MessageStore } from "../messaging/store.js";
import { AgentRegistry } from "../messaging/registry.js";
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
    messages: new MessageStore(root),
    agentRegistry: new AgentRegistry(root),
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
    expect(tools).toContain("oracle_ask");
    expect(tools).toContain("oracle_doctor");
    expect(tools).toContain("oracle_skills");
    expect(tools).toContain("oracle_oracle_list");
    expect(tools).toContain("oracle_oracle_register");
    expect(tools).toContain("oracle_memory_list");
    expect(tools).toContain("oracle_memory_clear");
    expect(tools).toContain("oracle_identity_show");
    expect(tools).toContain("oracle_identity_setup");
    expect(tools).toContain("oracle_persona_set");
    expect(tools).toContain("oracle_msg_send");
    expect(tools).toContain("oracle_msg_inbox");
    expect(tools).toContain("oracle_msg_ack");
    expect(tools).toContain("oracle_msg_thread");
  });

  test("register onboards an agent: roster + unread in one call, presence tracked", async () => {
    // A message is waiting before the agent ever registers.
    const pre = await client.callTool({
      name: "oracle_msg_send",
      arguments: { from: "scout", to: "newbie", body: "welcome task: read the skill doc" }
    });
    expect(pre.isError).not.toBe(true);

    const onboard = await client.callTool({
      name: "oracle_msg_register",
      arguments: { name: "newbie", role: "test agent" }
    });
    expect(onboard.isError).not.toBe(true);
    const sc = onboard.structuredContent as {
      agent: { name: string; role: string };
      unreadCount: number;
      roster: Array<{ name: string }>;
    };
    expect(sc.agent.name).toBe("newbie");
    expect(sc.agent.role).toBe("test agent");
    expect(sc.unreadCount).toBe(1);

    // Roster lists the registered agent; presence marked active.
    const agents = await client.callTool({ name: "oracle_msg_agents", arguments: {} });
    const list = (agents.structuredContent as { agents: Array<{ name: string; active: boolean }> }).agents;
    const me = list.find((a) => a.name === "newbie");
    expect(me).toBeDefined();
    expect(me?.active).toBe(true);

    // Re-registering is idempotent, not an error.
    const again = await client.callTool({
      name: "oracle_msg_register",
      arguments: { name: "newbie" }
    });
    expect(again.isError).not.toBe(true);
    expect((again.structuredContent as { agent: { role: string } }).agent.role).toBe("test agent");
  });

  test("agents exchange messages through the shared bus", async () => {
    const sent = await client.callTool({
      name: "oracle_msg_send",
      arguments: { from: "claude", to: "codex", body: "please review src/sample.ts", subject: "review" }
    });
    expect(sent.isError).not.toBe(true);
    const msgId = (sent.structuredContent as { id: string }).id;

    // Recipient sees it, sender does not.
    const codexInbox = await client.callTool({
      name: "oracle_msg_inbox",
      arguments: { agent: "codex" }
    });
    expect((codexInbox.structuredContent as { count: number }).count).toBe(1);
    const claudeInbox = await client.callTool({
      name: "oracle_msg_inbox",
      arguments: { agent: "claude" }
    });
    expect((claudeInbox.structuredContent as { count: number }).count).toBe(0);

    // Reply threads back to the original.
    const reply = await client.callTool({
      name: "oracle_msg_send",
      arguments: { from: "codex", to: "claude", body: "looks good", replyTo: msgId }
    });
    const thread = await client.callTool({
      name: "oracle_msg_thread",
      arguments: { id: (reply.structuredContent as { id: string }).id }
    });
    expect((thread.structuredContent as { count: number }).count).toBe(2);

    // Ack clears the unread inbox.
    const acked = await client.callTool({
      name: "oracle_msg_ack",
      arguments: { agent: "codex", ids: [msgId] }
    });
    expect((acked.structuredContent as { acked: string[] }).acked).toEqual([msgId]);
    const after = await client.callTool({
      name: "oracle_msg_inbox",
      arguments: { agent: "codex" }
    });
    expect((after.structuredContent as { count: number }).count).toBe(0);
  });

  test("consults, lists, retrieves, and diagnoses", async () => {
    const consultation = await client.callTool({
      name: "oracle_ask",
      arguments: { question: "Review this project" }
    });
    expect(consultation.isError).not.toBe(true);
    expect(consultation.structuredContent).toMatchObject({
      soul: "auto",
      filesIncluded: 0
    });
    expect(typeof (consultation.structuredContent as { sessionId: string }).sessionId).toBe("string");

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
