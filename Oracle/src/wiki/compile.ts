import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryPort } from "../orchestrator/ports.js";
import type { MemoryStoreEntry } from "../memory/adapter.js";

const WIKI_DIR = ".oracle/wiki";
const UNTAGGED_TOPIC = "general";
const FETCH_LIMIT = 10_000;

export interface WikiTopic {
  slug: string;
  title: string;
  active: MemoryStoreEntry[];
  archived: MemoryStoreEntry[];
}

function slugify(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || UNTAGGED_TOPIC;
}

/**
 * Group all fact/insight memories by topic (their first tag, or "general"
 * for untagged entries) — the same claim can legitimately live under
 * several topics if it carries several tags, since a memory-wiki page is a
 * *view*, not a second copy of the data.
 */
export async function groupByTopic(memory: MemoryPort): Promise<Map<string, WikiTopic>> {
  const [facts, insights] = await Promise.all([
    memory.recall({ type: "fact", limit: FETCH_LIMIT, includeArchived: true }),
    memory.recall({ type: "insight", limit: FETCH_LIMIT, includeArchived: true })
  ]);

  const topics = new Map<string, WikiTopic>();
  for (const entry of [...facts, ...insights]) {
    const tags = entry.tags.length > 0 ? entry.tags : [UNTAGGED_TOPIC];
    for (const tag of tags) {
      const slug = slugify(tag);
      let topic = topics.get(slug);
      if (!topic) {
        topic = { slug, title: tag, active: [], archived: [] };
        topics.set(slug, topic);
      }
      (entry.archived ? topic.archived : topic.active).push(entry);
    }
  }
  return topics;
}

function renderEntry(entry: MemoryStoreEntry): string {
  const parts = [`\`${entry.type}\``, `agent: ${entry.agent}`, `ts: ${entry.ts.slice(0, 19)}`];
  if (entry.importance !== undefined) parts.push(`importance: ${entry.importance.toFixed(2)}`);
  return `- ${entry.content}\n  <sub>${parts.join(" · ")}</sub>`;
}

export function renderTopicPage(topic: WikiTopic): string {
  const lines = [
    `# ${topic.title}`,
    "",
    `_compiled ${new Date().toISOString()} · ${topic.active.length} active, ${topic.archived.length} archived_`,
    ""
  ];

  lines.push("## Claims");
  if (topic.active.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const entry of topic.active.slice().sort((a, b) => b.ts.localeCompare(a.ts))) {
      lines.push(renderEntry(entry), "");
    }
  }

  if (topic.archived.length > 0) {
    lines.push("## Archived / superseded", "");
    for (const entry of topic.archived.slice().sort((a, b) => b.ts.localeCompare(a.ts))) {
      const suffix = entry.consolidatedBy ? ` (superseded by ${entry.consolidatedBy})` : "";
      lines.push(`- ~~${entry.content}~~${suffix}`, "");
    }
  }

  return lines.join("\n").trim() + "\n";
}

function renderIndexPage(topics: WikiTopic[]): string {
  return [
    "# Memory Wiki",
    "",
    `_${topics.length} topic(s), compiled ${new Date().toISOString()}_`,
    "",
    ...topics
      .slice()
      .sort((a, b) => b.active.length - a.active.length)
      .map((t) => `- [${t.title}](./${t.slug}.md) — ${t.active.length} active${t.archived.length ? `, ${t.archived.length} archived` : ""}`)
  ].join("\n").trim() + "\n";
}

export interface WikiBuildResult {
  topics: string[];
  path: string;
}

/** Compile all fact/insight memories into `.oracle/wiki/<topic>.md` + an index page. Overwrites on every call — deterministic, not incremental. */
export async function buildWiki(memory: MemoryPort, rootDir: string): Promise<WikiBuildResult> {
  const topics = await groupByTopic(memory);
  const dir = path.join(rootDir, WIKI_DIR);
  await fs.mkdir(dir, { recursive: true });

  const topicList = [...topics.values()];
  for (const topic of topicList) {
    await fs.writeFile(path.join(dir, `${topic.slug}.md`), renderTopicPage(topic), "utf8");
  }
  await fs.writeFile(path.join(dir, "index.md"), renderIndexPage(topicList), "utf8");

  return { topics: topicList.map((t) => t.slug), path: dir };
}

export async function getWikiPage(rootDir: string, slug: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(rootDir, WIKI_DIR, `${slugify(slug)}.md`), "utf8");
  } catch {
    return null;
  }
}

export async function listWikiTopics(rootDir: string): Promise<string[]> {
  try {
    const files = await fs.readdir(path.join(rootDir, WIKI_DIR));
    return files.filter((f) => f.endsWith(".md") && f !== "index.md").map((f) => f.replace(/\.md$/, "")).sort();
  } catch {
    return [];
  }
}
