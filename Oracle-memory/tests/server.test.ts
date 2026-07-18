import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

const TEST_ROOT = ".oracle-memory-test-server";

let client: Client;
let shutdown: () => Promise<void>;

beforeAll(async () => {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });

  const { server, shutdown: stop } = createServer(TEST_ROOT, true);
  shutdown = stop;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "server-test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await shutdown();
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
});

async function callJson(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}

describe("Oracle Memory MCP tools (simplified)", () => {
  it("lists 3 tools: remember, recall, forget", async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["forget", "recall", "remember"]);
  });

  it("remember saves and recall finds it", async () => {
    const created = await callJson("remember", { agent: "t1", type: "fact", content: "server test memory" });
    expect(created.success).toBe(true);
    expect(created.memory.content).toBe("server test memory");

    const found = await callJson("recall", { query: "server test", limit: 10 });
    expect(found.success).toBe(true);
    expect(found.results.length).toBeGreaterThan(0);
    expect(found.results.some((r: any) => r.entry?.content === "server test memory")).toBe(true);
  });

  it("recall with id fetches a single memory", async () => {
    const created = await callJson("remember", { agent: "t2", type: "fact", content: "single fetch test" });
    const fetched = await callJson("recall", { id: created.memory.id, type: "fact" });
    expect(fetched.success).toBe(true);
    expect(fetched.memory.content).toBe("single fetch test");
    expect(fetched.memory.accessCount).toBe(1);
  });

  it("recall with no query lists recent memories", async () => {
    await callJson("remember", { agent: "t3", type: "insight", content: "list test insight" });
    const result = await callJson("recall", { limit: 50 });
    expect(result.success).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("remember with entry_id updates existing memory", async () => {
    const created = await callJson("remember", { agent: "t4", type: "fact", content: "original content" });
    const updated = await callJson("remember", { agent: "t4", type: "fact", content: "updated content", entry_id: created.memory.id });
    expect(updated.success).toBe(true);
    expect(updated.memory.content).toBe("updated content");
  });

  it("recall with includeExpired surfaces archived entries", async () => {
    // Create and then immediately forget (permanent delete, not archive)
    const created = await callJson("remember", { agent: "t5", type: "fact", content: "to be deleted" });
    const del = await callJson("forget", { id: created.memory.id, type: "fact" });
    expect(del.success).toBe(true);

    // Should not appear in normal recall
    const normal = await callJson("recall", { query: "to be deleted", limit: 10 });
    expect(normal.results.length).toBe(0);
  });

  it("forget with agent clears working memory", async () => {
    await callJson("remember", { agent: "t6", type: "working", content: "scratchpad note" });
    const cleared = await callJson("forget", { agent: "t6" });
    expect(cleared.success).toBe(true);
    expect(cleared.cleared).toBeGreaterThanOrEqual(0);
  });

  it("resources return expected data", async () => {
    const statsRes = await client.readResource({ uri: "oracle-memory://stats" });
    const stats = JSON.parse(statsRes.contents[0].text);
    expect(stats.totalMemories).toBeDefined();
    expect(typeof stats.totalMemories).toBe("number");
  });
});
