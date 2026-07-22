import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { AgentMessage } from "./types.js";

/**
 * Checkpoint state for the agent loop. Saved after every tool-calling turn so
 * a crashed agent can resume from where it left off instead of starting over.
 *
 * Only the transcript is persisted — tool implementations are reconstructed
 * from the current environment on resume (they can't be serialized).
 */

export interface AgentCheckpoint {
  id: string;
  system: string;
  model: string;
  transcript: AgentMessage[];
  turn: number;
  maxSteps: number;
  toolNames?: string[];
  usage: { inputTokens: number; outputTokens: number };
  createdAt: string;
  updatedAt: string;
}

export class CheckpointStore {
  constructor(private readonly homeDir: string) {}

  private dir(): string {
    return path.join(this.homeDir, "checkpoints");
  }

  private filePath(id: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(id)) {
      throw new Error(`Invalid checkpoint id "${id}".`);
    }
    return path.join(this.dir(), `${id}.json`);
  }

  /** Save a checkpoint (atomic write). */
  async save(checkpoint: AgentCheckpoint): Promise<void> {
    await fs.mkdir(this.dir(), { recursive: true });
    const fp = this.filePath(checkpoint.id);
    const tmp = `${fp}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(checkpoint, null, 2), "utf8");
    await fs.rename(tmp, fp);
  }

  /** Load a checkpoint by id. Returns null if not found. */
  async load(id: string): Promise<AgentCheckpoint | null> {
    try {
      return JSON.parse(await fs.readFile(this.filePath(id), "utf8")) as AgentCheckpoint;
    } catch {
      return null;
    }
  }

  /** Delete a checkpoint (called on successful completion). */
  async delete(id: string): Promise<boolean> {
    try {
      await fs.rm(this.filePath(id));
      return true;
    } catch {
      return false;
    }
  }

  /** List all checkpoint IDs with timestamps. */
  async list(): Promise<{ id: string; updatedAt: string }[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir());
    } catch {
      return [];
    }
    const result: { id: string; updatedAt: string }[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(id)) continue;
      try {
        const cp = await this.load(id);
        if (cp) result.push({ id, updatedAt: cp.updatedAt });
      } catch { /* skip corrupt */ }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
