import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryAdapter } from "./adapter.js";

describe("MemoryAdapter — end to end", () => {
  let tmp: string;
  let memory: MemoryAdapter;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-memory-e2e-"));
    memory = new MemoryAdapter(tmp);
  });

  afterEach(async () => {
    // Let fire-and-forget writes (touchEntry, entity graph indexing) settle
    // before removing the temp dir — otherwise Windows can hit ENOTEMPTY.
    await new Promise((r) => setTimeout(r, 100));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  });

  it("remember -> recall round-trips content and tracks access", async () => {
    const entry = await memory.remember("me", "fact", "Oracle uses TypeScript and Redis", {
      tags: ["redis", "typescript"],
    });
    expect(entry.accessCount).toBe(0);

    const first = await memory.recall({ type: "fact" });
    expect(first).toHaveLength(1);
    expect(first[0].content).toBe("Oracle uses TypeScript and Redis");

    // recall() fire-and-forgets the access-count bump; wait a tick for it to land.
    await new Promise((r) => setTimeout(r, 50));
    const second = await memory.recall({ type: "fact" });
    expect(second[0].accessCount).toBeGreaterThanOrEqual(1);
  });

  it("forget removes the entry from disk", async () => {
    const entry = await memory.remember("me", "working", "scratch note");
    await memory.forget(entry.id, "working");
    const remaining = await memory.recall({ type: "working" });
    expect(remaining.find((e) => e.id === entry.id)).toBeUndefined();
  });

  it("searchMemories falls back to keyword filtering without Ollama", async () => {
    await memory.remember("me", "fact", "Postgres is the primary datastore");
    await memory.remember("me", "fact", "unrelated content about cats");
    const hits = await memory.searchMemories("postgres");
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain("Postgres");
  });

  it("deduplicates equivalent content and normalizes tags without an LLM call", async () => {
    const first = await memory.remember("me", "fact", "Oracle uses a shared task board.", { tags: ["Board", "board", "  Lead "] });
    const second = await memory.remember("other", "fact", " oracle   uses a shared task board. ", { tags: ["ignored"] });
    expect(second.id).toBe(first.id);
    expect(first.tags).toEqual(["board", "lead"]);
    expect(await memory.recall({ type: "fact" })).toHaveLength(1);
  });

  it("ranks partial multi-term matches instead of requiring the exact query phrase", async () => {
    await memory.remember("me", "fact", "The release checklist is owned by the lead.", { tags: ["release"] });
    await memory.remember("me", "fact", "A checklist exists for unrelated deploys.");
    const hits = await memory.searchMemories("lead release checklist");
    expect(hits[0].content).toContain("owned by the lead");
  });

  it("scoredSearchMemories still returns keyword matches ranked without Ollama", async () => {
    await memory.remember("me", "fact", "Docker containers run the build pipeline");
    const hits = await memory.scoredSearchMemories("docker");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain("Docker");
  });

  it("indexes entities into the graph and supports graphQuery/findPath", async () => {
    await memory.remember("me", "fact", "Oracle uses TypeScript and depends on Redis for caching", {
      tags: ["redis"],
    });
    // entity graph indexing is fire-and-forget on remember(); allow it to land.
    await new Promise((r) => setTimeout(r, 50));

    const stats = await memory.getGraphStats();
    expect(stats.entityCount).toBeGreaterThan(0);

    const results = await memory.graphQuery("TypeScript");
    expect(Array.isArray(results)).toBe(true);
  });

  it("consolidate merges entries with overlapping tags and archives the rest", async () => {
    await memory.remember("me", "fact", "First note about auth", { tags: ["auth", "security"] });
    await memory.remember("me", "fact", "Second note about auth", { tags: ["auth", "security"] });
    await memory.remember("me", "fact", "Unrelated note", { tags: ["unrelated"] });

    const result = await memory.consolidate();
    expect(result.consolidated).toBe(1);
    expect(result.archived).toHaveLength(1);

    const all = await memory.recall({ type: "fact", includeArchived: true, limit: 100 });
    const archived = all.filter((e) => e.archived);
    expect(archived).toHaveLength(1);
    expect(archived[0].consolidatedBy).toBeDefined();

    // Archived entries are hidden from recall by default
    const visible = await memory.recall({ type: "fact", limit: 100 });
    expect(visible.every((e) => !e.archived)).toBe(true);
  });

  it("pruneStale flags old, low-importance, low-access memories", async () => {
    const stale = await memory.remember("me", "fact", "old unused fact", { importance: 0.05 });
    // Backdate lastAccessed/ts well past the staleness window.
    const filePath = path.join(tmp, ".oracle-memory", "facts", `${stale.id}.json`);
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    raw.lastAccessed = new Date(Date.now() - 90 * 86_400_000).toISOString();
    raw.ts = raw.lastAccessed;
    await fs.writeFile(filePath, JSON.stringify(raw), "utf8");

    const pruned = await memory.pruneStale({ minStaleDays: 30, minImportance: 0.2 });
    expect(pruned).toContain(stale.id);
  });

  it("promoteWorking graduates high-access working memories to insight", async () => {
    const working = await memory.remember("me", "working", "frequently recalled scratch note");
    // Simulate repeated access without waiting on recall()'s fire-and-forget touch.
    const filePath = path.join(tmp, ".oracle-memory", "working", `${working.id}.json`);
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    raw.accessCount = 5;
    await fs.writeFile(filePath, JSON.stringify(raw), "utf8");

    const promoted = await memory.promoteWorking({ minAccessCount: 3 });
    expect(promoted).toContain(working.id);

    const insights = await memory.recall({ type: "insight" });
    expect(insights.some((e) => e.content === "frequently recalled scratch note")).toBe(true);
    const workingLeft = await memory.recall({ type: "working" });
    expect(workingLeft.find((e) => e.id === working.id)).toBeUndefined();
  });

  it("runMaintenance runs prune + promote together", async () => {
    const result = await memory.runMaintenance();
    expect(result).toHaveProperty("pruned");
    expect(result).toHaveProperty("promoted");
  });

  it("full lifecycle: remember many, consolidate, maintain, then forget survivors", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const e = await memory.remember("me", "fact", `Note ${i} about caching layers`, {
        tags: ["cache", "perf"],
      });
      ids.push(e.id);
    }

    const consolidateResult = await memory.consolidate();
    expect(consolidateResult.consolidated).toBe(2);

    const maintResult = await memory.runMaintenance();
    expect(maintResult.pruned).toEqual([]);

    const survivors = await memory.recall({ type: "fact", limit: 100 });
    expect(survivors).toHaveLength(1);

    for (const s of survivors) {
      await memory.forget(s.id, "fact");
    }
    const afterForget = await memory.recall({ type: "fact", includeArchived: true, limit: 100 });
    expect(afterForget.filter((e) => !e.archived)).toHaveLength(0);
  });
});
