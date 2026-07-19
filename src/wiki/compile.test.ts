import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryAdapter } from "../memory/adapter.js";
import { groupByTopic, buildWiki, getWikiPage, listWikiTopics, renderTopicPage } from "./compile.js";

describe("memory wiki", () => {
  let tmp: string;
  let memory: MemoryAdapter;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-wiki-test-"));
    memory = new MemoryAdapter(tmp);
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  describe("groupByTopic", () => {
    it("groups untagged entries under 'general'", async () => {
      await memory.remember("me", "fact", "no tags here");
      const topics = await groupByTopic(memory);
      expect(topics.get("general")?.active).toHaveLength(1);
    });

    it("groups entries by their first-class tags", async () => {
      await memory.remember("me", "fact", "redis fact", { tags: ["redis"] });
      await memory.remember("me", "insight", "redis insight", { tags: ["redis"] });
      await memory.remember("me", "fact", "postgres fact", { tags: ["postgres"] });
      const topics = await groupByTopic(memory);
      expect(topics.get("redis")?.active).toHaveLength(2);
      expect(topics.get("postgres")?.active).toHaveLength(1);
    });

    it("a multi-tagged entry appears under every one of its topics", async () => {
      await memory.remember("me", "fact", "cross-cutting fact", { tags: ["redis", "caching"] });
      const topics = await groupByTopic(memory);
      expect(topics.get("redis")?.active).toHaveLength(1);
      expect(topics.get("caching")?.active).toHaveLength(1);
    });

    it("separates archived entries from active ones", async () => {
      const entry = await memory.remember("me", "fact", "will be archived", { tags: ["x"] });
      // MemoryAdapter has no archive() call directly; simulate via updateMemory
      // is not enough (no archived flag setter) — write raw instead.
      const filePath = path.join(tmp, ".oracle-memory", "facts", `${entry.id}.json`);
      const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
      raw.archived = true;
      raw.consolidatedBy = "some-newer-id";
      await fs.writeFile(filePath, JSON.stringify(raw), "utf8");

      const topics = await groupByTopic(memory);
      expect(topics.get("x")?.active).toHaveLength(0);
      expect(topics.get("x")?.archived).toHaveLength(1);
      expect(topics.get("x")?.archived[0].consolidatedBy).toBe("some-newer-id");
    });

    it("does not include working memories (only fact/insight)", async () => {
      await memory.remember("me", "working", "scratch note", { tags: ["x"] });
      const topics = await groupByTopic(memory);
      expect(topics.has("x")).toBe(false);
    });
  });

  describe("renderTopicPage", () => {
    it("renders active claims and archived ones separately", () => {
      const page = renderTopicPage({
        slug: "redis",
        title: "redis",
        active: [{ id: "1", ts: "2026-01-01T00:00:00.000Z", agent: "me", type: "fact", content: "active claim", tags: ["redis"], meta: {} }],
        archived: [{ id: "2", ts: "2026-01-01T00:00:00.000Z", agent: "me", type: "fact", content: "old claim", tags: ["redis"], meta: {}, archived: true, consolidatedBy: "1" }]
      });
      expect(page).toContain("active claim");
      expect(page).toContain("~~old claim~~");
      expect(page).toContain("superseded by 1");
    });
  });

  describe("buildWiki / getWikiPage / listWikiTopics", () => {
    it("writes one file per topic plus an index, and getWikiPage/listWikiTopics read them back", async () => {
      await memory.remember("me", "fact", "redis fact", { tags: ["redis"] });
      await memory.remember("me", "fact", "postgres fact", { tags: ["postgres"] });

      const result = await buildWiki(memory, tmp);
      expect(result.topics.sort()).toEqual(["postgres", "redis"]);

      const topics = await listWikiTopics(tmp);
      expect(topics).toEqual(["postgres", "redis"]);

      const redisPage = await getWikiPage(tmp, "redis");
      expect(redisPage).toContain("redis fact");

      const index = await fs.readFile(path.join(tmp, ".oracle", "wiki", "index.md"), "utf8");
      expect(index).toContain("redis");
      expect(index).toContain("postgres");
    });

    it("getWikiPage returns null for a topic that was never built", async () => {
      expect(await getWikiPage(tmp, "nonexistent")).toBeNull();
    });

    it("overwrites the previous build deterministically", async () => {
      await memory.remember("me", "fact", "first", { tags: ["x"] });
      await buildWiki(memory, tmp);
      await memory.remember("me", "fact", "second", { tags: ["x"] });
      await buildWiki(memory, tmp);
      const page = await getWikiPage(tmp, "x");
      expect(page).toContain("first");
      expect(page).toContain("second");
    });
  });
});
