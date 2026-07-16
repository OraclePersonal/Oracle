import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { MemoryPort } from "../orchestrator/ports.js";

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

function generateId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const micros = String(now.getMilliseconds()).padStart(3, "0") + "000";
  const rand = crypto.randomBytes(6).toString("hex");
  return `${date}-${time}-${micros}-${rand}`;
}

export class MemoryAdapter implements MemoryPort {
  constructor(private readonly rootDir: string) {}

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
    const filePath = path.join(this.typeDir(type), `${entry.id}.json`);
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entry, null, 2), "utf8");
    await fs.rename(tmp, filePath);
    return entry;
  }

  async recall(type?: MemoryType, agent?: string, limit = 20): Promise<MemoryStoreEntry[]> {
    const dirs = type
      ? [this.typeDir(type)]
      : Object.values(TYPE_DIR).map((d) => path.join(this.dataDir(), d));
    const entries: MemoryStoreEntry[] = [];
    for (const dir of dirs) {
      try {
        // Filenames are timestamp-prefixed, so lexical sort == chronological order.
        // readdir() gives no ordering guarantee — sort before slicing or the most
        // recent entries can be silently dropped once a dir exceeds the slice window.
        const files = (await fs.readdir(dir)).sort();
        for (const file of files.slice(-(limit * 2))) {
          if (!file.endsWith(".json")) continue;
          try {
            const entry = JSON.parse(await fs.readFile(path.join(dir, file), "utf8")) as MemoryStoreEntry;
            if (entry.archived) continue;
            if (agent && entry.agent !== agent) continue;
            entries.push(entry);
          } catch { /* skip corrupt */ }
        }
      } catch { /* dir not ready */ }
    }
    return entries.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);
  }

  async forget(id: string, type: MemoryType): Promise<void> {
    try {
      await fs.unlink(path.join(this.typeDir(type), `${id}.json`));
    } catch { /* ignore */ }
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
        await fs.unlink(path.join(dir, file));
        count++;
      }
    } catch { /* ignore */ }
    return count;
  }
}
