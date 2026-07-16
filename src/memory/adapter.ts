import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// ponytail: writes directly to .agoya/ format — zero deps, no MCP needed.
// Agoya server reads the same files, so memory is shared transparently.

export type MemoryType = "fact" | "insight" | "chunk" | "working";

export interface AgoyaMemoryEntry {
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

export class AgoyaAdapter {
  constructor(private readonly rootDir: string) {}

  private agoyaDir(): string {
    return path.join(this.rootDir, ".agoya");
  }

  private typeDir(type: MemoryType): string {
    return path.join(this.agoyaDir(), TYPE_DIR[type]);
  }

  private async ensureDirs(): Promise<void> {
    await fs.mkdir(this.agoyaDir(), { recursive: true });
    for (const dir of Object.values(TYPE_DIR)) {
      await fs.mkdir(path.join(this.agoyaDir(), dir), { recursive: true });
    }
  }

  async remember(
    agent: string,
    type: MemoryType,
    content: string,
    opts?: { tags?: string[]; meta?: Record<string, unknown>; importance?: number }
  ): Promise<AgoyaMemoryEntry> {
    await this.ensureDirs();
    const entry: AgoyaMemoryEntry = {
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

  async recall(type?: MemoryType, agent?: string, limit = 20): Promise<AgoyaMemoryEntry[]> {
    const dirs = type ? [this.typeDir(type)] : Object.values(TYPE_DIR).map((d) => path.join(this.agoyaDir(), d));
    const entries: AgoyaMemoryEntry[] = [];
    for (const dir of dirs) {
      try {
        const files = await fs.readdir(dir);
        for (const file of files.slice(-limit)) {
          if (!file.endsWith(".json")) continue;
          const raw = await fs.readFile(path.join(dir, file), "utf8");
          const entry = JSON.parse(raw) as AgoyaMemoryEntry;
          if (entry.archived) continue;
          if (agent && entry.agent !== agent) continue;
          entries.push(entry);
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
          const raw = await fs.readFile(path.join(dir, file), "utf8");
          const entry = JSON.parse(raw) as AgoyaMemoryEntry;
          if (entry.agent !== agent) continue;
        }
        await fs.unlink(path.join(dir, file));
        count++;
      }
    } catch { /* ignore */ }
    return count;
  }
}
