import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { MemoryPort } from "../orchestrator/ports.js";
import { generateEmbedding } from "./ollama.js";
import { VectorStore } from "./vectorStore.js";

// ponytail: writes directly to .oracle-memory/ format — zero deps, no MCP needed.
// oracle-memory server reads the same files, so memory is shared transparently.

export type MemoryType = "fact" | "insight" | "chunk" | "working";

export interface MemoryStoreEntry {
  id: string;
  ts: string;
  agent: string;
  type: MemoryType;
  content: string;
  tags: string[];
  meta: Record<string, unknown>;
  ttl?: number;
  source?: string;
  importance?: number;
  archived?: boolean;
  consolidatedBy?: string;
}

const DATA_DIR = ".oracle-memory";
const TYPE_DIR: Record<MemoryType, string> = {
  fact: "facts",
  insight: "insights",
  chunk: "chunks",
  working: "working",
};
const USE_OLLAMA = process.env.ORACLE_USE_OLLAMA === "1" || process.env.ORACLE_USE_OLLAMA === "true";

function generateId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const micros = String(now.getMilliseconds()).padStart(3, "0") + "000";
  const rand = crypto.randomBytes(6).toString("hex");
  return `${date}-${time}-${micros}-${rand}`;
}

export class MemoryAdapter implements MemoryPort {
  private vectors: VectorStore;
  private vectorsLoaded = false;

  constructor(private readonly rootDir: string) {
    this.vectors = new VectorStore(rootDir);
  }

  private dataDir(): string {
    return path.join(this.rootDir, DATA_DIR);
  }

  private typeDir(type: MemoryType): string {
    return path.join(this.dataDir(), TYPE_DIR[type]);
  }

  private async ensureDirs(): Promise<void> {
    await fs.mkdir(this.dataDir(), { recursive: true });
    for (const dir of Object.values(TYPE_DIR)) {
      await fs.mkdir(path.join(this.dataDir(), dir), { recursive: true });
    }
  }

  private async ensureVectors(): Promise<void> {
    if (!USE_OLLAMA || this.vectorsLoaded) return;
    await this.vectors.load();
    this.vectorsLoaded = true;
  }

  private filePath(type: MemoryType, id: string): string {
    return path.join(this.typeDir(type), `${id}.json`);
  }

  private async readEntry(type: MemoryType, id: string): Promise<MemoryStoreEntry | null> {
    try {
      return JSON.parse(await fs.readFile(this.filePath(type, id), "utf8")) as MemoryStoreEntry;
    } catch { return null; }
  }

  private async writeEntry(entry: MemoryStoreEntry): Promise<void> {
    const fp = this.filePath(entry.type, entry.id);
    const tmp = `${fp}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entry, null, 2), "utf8");
    await fs.rename(tmp, fp);
  }

  async remember(
    agent: string,
    type: MemoryType,
    content: string,
    opts?: { tags?: string[]; meta?: Record<string, unknown>; importance?: number }
  ): Promise<MemoryStoreEntry> {
    await this.ensureDirs();
    const entry: MemoryStoreEntry = {
      id: generateId(),
      ts: new Date().toISOString(),
      agent,
      type,
      content,
      tags: opts?.tags ?? [],
      meta: opts?.meta ?? {},
      importance: opts?.importance ?? 0.5,
    };
    await this.writeEntry(entry);

    // ponytail: fire-and-forget vector index — never blocks remember
    if (USE_OLLAMA) {
      this.ensureVectors().then(() => this.vectors.index(entry.id, content)).catch(() => {});
    }
    return entry;
  }

  async recall(opts?: { type?: MemoryType; agent?: string; tags?: string[]; limit?: number; includeArchived?: boolean }): Promise<MemoryStoreEntry[]> {
    const type = opts?.type;
    const agent = opts?.agent;
    const tags = opts?.tags;
    const limit = opts?.limit ?? 20;
    const includeArchived = opts?.includeArchived ?? false;
    const dirs = type
      ? [this.typeDir(type)]
      : Object.values(TYPE_DIR).map((d) => path.join(this.dataDir(), d));
    const entries: MemoryStoreEntry[] = [];
    for (const dir of dirs) {
      try {
        const files = (await fs.readdir(dir)).sort();
        for (const file of files.slice(-(limit * 4))) {
          if (!file.endsWith(".json")) continue;
          try {
            const entry = JSON.parse(await fs.readFile(path.join(dir, file), "utf8")) as MemoryStoreEntry;
            if (entry.archived && !includeArchived) continue;
            if (agent && entry.agent !== agent) continue;
            if (tags && !tags.some((t) => entry.tags.includes(t))) continue;
            entries.push(entry);
          } catch { /* skip corrupt */ }
        }
      } catch { /* dir not ready */ }
    }
    return entries.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);
  }

  async searchMemories(query: string, opts?: { type?: MemoryType; agent?: string; limit?: number }): Promise<MemoryStoreEntry[]> {
    const limit = opts?.limit ?? 50;
    const q = query.toLowerCase();

    // Try semantic search via Ollama (whitelist: non-empty query)
    if (USE_OLLAMA && q.length > 0) {
      await this.ensureVectors();
      const queryEmb = await generateEmbedding(query);
      if (queryEmb) {
        const hits = this.vectors.search(queryEmb.embedding, limit * 2);
        if (hits.length > 0) {
          const ids = new Map(hits.map((h) => [h.memoryId, h.score]));
          const all = await this.recall({ type: opts?.type, agent: opts?.agent, limit: 10_000 });
          const scored = all
            .filter((e) => ids.has(e.id))
            .map((e) => ({ entry: e, score: ids.get(e.id)! }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
          return scored.map((s) => s.entry);
        }
      }
    }

    // Fallback: keyword filter
    const entries = await this.recall({ type: opts?.type, agent: opts?.agent, limit });
    return entries.filter((e) => e.content.toLowerCase().includes(q) || e.tags.some((t) => t.toLowerCase().includes(q)));
  }

  async updateMemory(id: string, type: MemoryType, updates: { content?: string; tags?: string[]; importance?: number }): Promise<MemoryStoreEntry | null> {
    const entry = await this.readEntry(type, id);
    if (!entry) return null;
    if (updates.content !== undefined) entry.content = updates.content;
    if (updates.tags !== undefined) entry.tags = updates.tags;
    if (updates.importance !== undefined) entry.importance = updates.importance;
    await this.writeEntry(entry);
    if (USE_OLLAMA && updates.content !== undefined) {
      this.ensureVectors().then(() => this.vectors.index(id, entry.content)).catch(() => {});
    }
    return entry;
  }

  async getStats(): Promise<{ total: number; byType: Record<string, number>; byAgent: Record<string, number> }> {
    const all = await this.recall({ limit: 10_000 });
    const byType: Record<string, number> = {};
    const byAgent: Record<string, number> = {};
    for (const e of all) {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
      byAgent[e.agent] = (byAgent[e.agent] ?? 0) + 1;
    }
    return { total: all.length, byType, byAgent };
  }

  async forget(id: string, type: MemoryType): Promise<void> {
    try {
      await fs.unlink(this.filePath(type, id));
    } catch { /* ignore */ }
    if (USE_OLLAMA) this.vectors.remove(id).catch(() => {});
  }

  async clearWorking(agent?: string): Promise<number> {
    let count = 0;
    const dir = this.typeDir("working");
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        if (agent) {
          try {
            const entry = JSON.parse(await fs.readFile(path.join(dir, file), "utf8")) as MemoryStoreEntry;
            if (entry.agent !== agent) continue;
          } catch { continue; }
        }
        const id = file.replace(".json", "");
        await fs.unlink(path.join(dir, file));
        if (USE_OLLAMA) this.vectors.remove(id).catch(() => {});
        count++;
      }
    } catch { /* ignore */ }
    return count;
  }
}
