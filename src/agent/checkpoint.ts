import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AgentMessage } from "./types.js";

const execAsync = promisify(exec);

export interface ShadowGitCheckpoint {
  id: string;
  timestamp: string;
  label?: string;
  stashRef?: string;
  filesModified: string[];
}

export interface CheckpointRecord {
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

export type AgentCheckpoint = CheckpointRecord;

export interface CheckpointStoreInterface {
  load(id: string): Promise<CheckpointRecord | null>;
  save(record: CheckpointRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
  list(): Promise<Array<{ id: string; updatedAt: string }>>;
}

export class FileCheckpointStore implements CheckpointStoreInterface {
  constructor(private readonly dir: string) {}

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private isValidId(id: string): boolean {
    return Boolean(id) && !id.includes("..") && !id.includes("/") && !id.includes("\\");
  }

  async load(id: string): Promise<CheckpointRecord | null> {
    if (!this.isValidId(id)) return null;
    try {
      const raw = await fs.readFile(this.filePath(id), "utf8");
      return JSON.parse(raw) as CheckpointRecord;
    } catch {
      return null;
    }
  }

  async save(record: CheckpointRecord): Promise<void> {
    if (!this.isValidId(record.id)) {
      throw new Error(`Invalid checkpoint id: ${record.id}`);
    }
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.filePath(record.id)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
    await fs.rename(tmp, this.filePath(record.id));
  }

  async delete(id: string): Promise<boolean> {
    if (!this.isValidId(id)) return false;
    try {
      await fs.unlink(this.filePath(id));
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<Array<{ id: string; updatedAt: string }>> {
    try {
      const files = await fs.readdir(this.dir);
      const list: Array<{ id: string; updatedAt: string }> = [];
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
          const raw = await fs.readFile(path.join(this.dir, f), "utf8");
          const cp = JSON.parse(raw) as CheckpointRecord;
          list.push({ id: cp.id, updatedAt: cp.updatedAt });
        } catch { /* skip */ }
      }
      return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }
}

export { FileCheckpointStore as CheckpointStore };

export class ShadowGitEngine {
  private checkpointsDir(workspaceRoot: string): string {
    return path.join(workspaceRoot, ".oracle", "checkpoints");
  }

  private async ensureDir(workspaceRoot: string): Promise<void> {
    await fs.mkdir(this.checkpointsDir(workspaceRoot), { recursive: true });
  }

  /**
   * Create a shadow checkpoint before mutating workspace files.
   */
  async createCheckpoint(workspaceRoot: string, label?: string): Promise<ShadowGitCheckpoint> {
    await this.ensureDir(workspaceRoot);
    const id = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const timestamp = new Date().toISOString();

    let stashRef: string | undefined;
    let filesModified: string[] = [];

    try {
      const { stdout: status } = await execAsync("git status --porcelain", { cwd: workspaceRoot });
      filesModified = status
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(3).trim());

      const { stdout: stashOut } = await execAsync(`git stash create "oracle_checkpoint_${id}"`, { cwd: workspaceRoot });
      stashRef = stashOut.trim() || undefined;
    } catch {
      // Fallback
    }

    const checkpoint: ShadowGitCheckpoint = {
      id,
      timestamp,
      label,
      stashRef,
      filesModified,
    };

    const filePath = path.join(this.checkpointsDir(workspaceRoot), `${id}.json`);
    await fs.writeFile(filePath, JSON.stringify(checkpoint, null, 2), "utf8");
    return checkpoint;
  }

  /**
   * Rollback workspace state to a target checkpoint.
   */
  async revertCheckpoint(workspaceRoot: string, checkpointId: string): Promise<{ restoredFiles: string[] }> {
    const filePath = path.join(this.checkpointsDir(workspaceRoot), `${checkpointId}.json`);
    const raw = await fs.readFile(filePath, "utf8");
    const checkpoint = JSON.parse(raw) as ShadowGitCheckpoint;

    if (checkpoint.stashRef) {
      try {
        await execAsync(`git stash apply ${checkpoint.stashRef}`, { cwd: workspaceRoot });
      } catch {
        // Stash apply fallback
      }
    }

    return { restoredFiles: checkpoint.filesModified };
  }

  /**
   * List all stored checkpoints.
   */
  async listCheckpoints(workspaceRoot: string): Promise<ShadowGitCheckpoint[]> {
    try {
      const dir = this.checkpointsDir(workspaceRoot);
      const files = await fs.readdir(dir);
      const list: ShadowGitCheckpoint[] = [];
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
          const raw = await fs.readFile(path.join(dir, f), "utf8");
          list.push(JSON.parse(raw) as ShadowGitCheckpoint);
        } catch { /* skip */ }
      }
      return list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    } catch {
      return [];
    }
  }
}
