import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { type MemoryEntry, type MemoryType, type StoreStats } from "./types.js";

const DATA_DIR = ".oracle-memory";
const MEMORY_TYPES: MemoryType[] = ["fact", "insight", "chunk", "working"];
const TYPE_DIR: Record<MemoryType, string> = {
  fact: "facts",
  insight: "insights",
  chunk: "chunks",
  working: "working",
};
const ALL_DIRS = Object.values(TYPE_DIR);
const CONFIG_FILE = "config.json";

export class Store {
  private rootDir: string;
  private ready: Promise<void>;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const dataDir = this.dataPath();
    await fs.mkdir(dataDir, { recursive: true });
    for (const dir of ALL_DIRS) {
      await fs.mkdir(path.join(dataDir, dir), { recursive: true });
    }
    // Ensure config exists
    const configPath = this.configPath();
    try {
      await fs.access(configPath);
    } catch {
      await this.atomicWriteJson(configPath, { created: new Date().toISOString(), version: 1 });
    }
  }

  private dataPath(): string {
    return path.join(this.rootDir, DATA_DIR);
  }

  private typeDir(type: MemoryType): string {
    return path.join(this.dataPath(), TYPE_DIR[type]);
  }

  private configPath(): string {
    return path.join(this.dataPath(), CONFIG_FILE);
  }

  private entryPath(id: string, type: MemoryType): string {
    return path.join(this.typeDir(type), `${id}.json`);
  }

  // --- Atomic JSON I/O ---

  async atomicWriteJson(filePath: string, data: unknown): Promise<void> {
    // Unique per-call suffix (pid + random) — a fixed `${filePath}.tmp` name
    // races when two writes to the same entry overlap in-process (e.g. a
    // fire-and-forget touch() from recall() landing mid-flight while
    // get_memory() touches the same entry): both writers share one tmp
    // file, so whichever renames second gets ENOENT on an already-consumed
    // path instead of a clean write.
    const tmp = `${filePath}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");

    // Even with a unique tmp name, two concurrent writers can still race on
    // the *destination*: on Windows, fs.rename to a path another rename is
    // simultaneously replacing can transiently fail with EPERM/EBUSY (the
    // destination is momentarily locked mid-replace), not just ENOENT.
    // Retry briefly — this is a transient OS-level lock, not a real error.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.rename(tmp, filePath);
        return;
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EBUSY") throw err;
        await new Promise((r) => setTimeout(r, 5 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  private async readJson<T>(filePath: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  // --- CRUD ---

  async createEntry(entry: MemoryEntry): Promise<MemoryEntry> {
    await this.ready;
    await this.atomicWriteJson(this.entryPath(entry.id, entry.type), entry);
    return entry;
  }

  async getEntry(id: string, type: MemoryType): Promise<MemoryEntry | null> {
    await this.ready;
    return this.readJson<MemoryEntry>(this.entryPath(id, type));
  }

  async listEntries(type?: MemoryType): Promise<MemoryEntry[]> {
    await this.ready;
    if (type) {
      return this.listFromDir(this.typeDir(type));
    }
    const all: MemoryEntry[] = [];
    for (const t of MEMORY_TYPES) {
      const entries = await this.listFromDir(this.typeDir(t));
      all.push(...entries);
    }
    all.sort((a, b) => b.ts.localeCompare(a.ts));
    return all;
  }

  private async listFromDir(dir: string): Promise<MemoryEntry[]> {
    try {
      const files = await fs.readdir(dir);
      const entries: MemoryEntry[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const entry = await this.readJson<MemoryEntry>(path.join(dir, file));
        if (entry) entries.push(entry);
      }
      return entries;
    } catch {
      return [];
    }
  }

  async updateEntry(entry: MemoryEntry): Promise<void> {
    await this.ready;
    await this.atomicWriteJson(this.entryPath(entry.id, entry.type), entry);
  }

  /**
   * Record a retrieval: bump accessCount and lastAccessedAt. Read-modify-write
   * is fine here — single-process daemon, and a lost increment under a rare
   * concurrent recall is a non-issue for a usage-frequency heuristic.
   */
  async touch(id: string, type: MemoryType, at: Date = new Date()): Promise<MemoryEntry | null> {
    await this.ready;
    const entry = await this.getEntry(id, type);
    if (!entry) return null;
    entry.accessCount = (entry.accessCount ?? 0) + 1;
    entry.lastAccessedAt = at.toISOString();
    await this.updateEntry(entry);
    return entry;
  }

  /**
   * Move an entry to a different memory type (e.g. working → insight on
   * promotion). Type determines the storage directory, so this is a
   * write-then-delete rather than an in-place update.
   */
  async moveType(entry: MemoryEntry, newType: MemoryType): Promise<MemoryEntry> {
    await this.ready;
    const oldPath = this.entryPath(entry.id, entry.type);
    const moved: MemoryEntry = { ...entry, type: newType };
    await this.atomicWriteJson(this.entryPath(moved.id, newType), moved);
    await fs.unlink(oldPath).catch(() => undefined);
    return moved;
  }

  async deleteEntry(id: string, type: MemoryType): Promise<boolean> {
    await this.ready;
    try {
      await fs.unlink(this.entryPath(id, type));
      return true;
    } catch {
      return false;
    }
  }

  async getStats(): Promise<StoreStats> {
    await this.ready;
    const all = await this.listEntries();
    const byType: Record<string, number> = { fact: 0, insight: 0, chunk: 0, working: 0 };
    const byAgent: Record<string, number> = {};

    for (const e of all) {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
      byAgent[e.agent] = (byAgent[e.agent] ?? 0) + 1;
    }

    return {
      totalMemories: all.length,
      byType: byType as Record<MemoryType, number>,
      byAgent,
      // Freshness classification lives in importance.ts, which store.ts (pure
      // file I/O, no business logic) intentionally doesn't depend on —
      // MemoryStore.getStats() fills this in for real.
      byFreshness: { new: 0, recent: 0, aging: 0, stale: 0 },
      oldestMemory: all.length > 0 ? all[all.length - 1]?.id ?? null : null,
      newestMemory: all.length > 0 ? all[0]?.id ?? null : null,
    };
  }

  async clearType(type: MemoryType, agent?: string): Promise<number> {
    await this.ready;
    const entries = await this.listEntries(type);
    const toDelete = agent ? entries.filter((e) => e.agent === agent) : entries;

    for (const e of toDelete) {
      try {
        await fs.unlink(this.entryPath(e.id, e.type));
      } catch {
        // skip already-deleted
      }
    }

    return toDelete.length;
  }
}
