import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CreateTaskInput,
  CronTask,
  CronTaskRepository,
  CronTaskStatus,
  UpdateTaskInput
} from "../scheduler/taskStore.js";

export interface RuntimeEvent {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface CronTaskRow {
  id: string;
  name: string;
  cron: string;
  command: string;
  description: string | null;
  status: CronTaskStatus;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  last_result: "success" | "error" | null;
  last_output: string | null;
}

interface RuntimeEventRow {
  id: number;
  type: string;
  payload_json: string;
  created_at: string;
}

export class RuntimeDatabase {
  readonly filePath: string;
  readonly connection: DatabaseSync;

  constructor(homeDir: string, filePath = path.join(homeDir, "runtime", "oracle.db")) {
    this.filePath = filePath;
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    this.connection = new DatabaseSync(filePath, { timeout: 5000 });
    fsSync.chmodSync(filePath, 0o600);
    this.migrate();
  }

  close(): void {
    this.connection.close();
  }

  recordEvent(type: string, payload: Record<string, unknown>): RuntimeEvent {
    const createdAt = new Date().toISOString();
    const result = this.connection.prepare(
      "INSERT INTO runtime_events (type, payload_json, created_at) VALUES (?, ?, ?)"
    ).run(type, JSON.stringify(payload), createdAt);
    return {
      id: Number(result.lastInsertRowid),
      type,
      payload,
      createdAt
    };
  }

  listEvents(afterId = 0, limit = 100): RuntimeEvent[] {
    const safeLimit = Math.min(Math.max(limit, 1), 1000);
    const rows = this.connection.prepare(
      "SELECT id, type, payload_json, created_at FROM runtime_events WHERE id > ? ORDER BY id ASC LIMIT ?"
    ).all(afterId, safeLimit) as unknown as RuntimeEventRow[];
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at
    }));
  }

  private migrate(): void {
    this.connection.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS runtime_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS scheduler_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cron TEXT NOT NULL,
        command TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'deleted')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run_at TEXT,
        last_result TEXT CHECK (last_result IN ('success', 'error')),
        last_output TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS scheduler_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES scheduler_tasks(id) ON DELETE CASCADE,
        result TEXT NOT NULL CHECK (result IN ('success', 'error')),
        output TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS scheduler_tasks_status_idx
        ON scheduler_tasks(status);
      CREATE INDEX IF NOT EXISTS scheduler_runs_task_idx
        ON scheduler_runs(task_id, id DESC);

      CREATE TABLE IF NOT EXISTS runtime_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO runtime_metadata (key, value, updated_at)
      VALUES ('schema_version', '1', datetime('now'))
      ON CONFLICT(key) DO NOTHING;
    `);
  }
}

export class SqliteCronTaskStore implements CronTaskRepository {
  constructor(private readonly runtime: RuntimeDatabase) {}

  async create(input: CreateTaskInput): Promise<CronTask> {
    const now = new Date().toISOString();
    const task: CronTask = {
      id: this.newId(),
      name: input.name,
      cron: input.cron,
      command: input.command,
      description: input.description,
      status: "active",
      createdAt: now,
      updatedAt: now
    };
    this.insert(task, false);
    return task;
  }

  async get(id: string): Promise<CronTask | null> {
    const row = this.runtime.connection.prepare(
      "SELECT * FROM scheduler_tasks WHERE id = ?"
    ).get(id) as CronTaskRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  async list(): Promise<CronTask[]> {
    const rows = this.runtime.connection.prepare(
      "SELECT * FROM scheduler_tasks WHERE status != 'deleted' ORDER BY created_at ASC"
    ).all() as unknown as CronTaskRow[];
    return rows.map((row) => this.fromRow(row));
  }

  async update(id: string, input: UpdateTaskInput): Promise<CronTask | null> {
    const current = await this.get(id);
    if (!current) return null;
    const updated: CronTask = {
      ...current,
      ...input,
      updatedAt: new Date().toISOString()
    };
    this.runtime.connection.prepare(`
      UPDATE scheduler_tasks
      SET name = ?, cron = ?, command = ?, description = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(
      updated.name,
      updated.cron,
      updated.command,
      updated.description ?? null,
      updated.status,
      updated.updatedAt,
      id
    );
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const result = this.runtime.connection.prepare(
      "DELETE FROM scheduler_tasks WHERE id = ?"
    ).run(id);
    return result.changes > 0;
  }

  async recordRun(id: string, result: "success" | "error", output: string): Promise<void> {
    const now = new Date().toISOString();
    const truncated = output.slice(0, 4000);
    this.runtime.connection.exec("BEGIN IMMEDIATE");
    try {
      this.runtime.connection.prepare(`
        UPDATE scheduler_tasks
        SET last_run_at = ?, last_result = ?, last_output = ?, updated_at = ?
        WHERE id = ?
      `).run(now, result, truncated, now, id);
      this.runtime.connection.prepare(`
        INSERT INTO scheduler_runs (task_id, result, output, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, result, truncated, now, now);
      this.runtime.connection.exec("COMMIT");
    } catch (error) {
      this.runtime.connection.exec("ROLLBACK");
      throw error;
    }
  }

  async importLegacyDirectory(homeDir: string): Promise<number> {
    const directory = path.join(homeDir, "scheduler");
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch {
      return 0;
    }

    let imported = 0;
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      try {
        const task = JSON.parse(
          await fs.readFile(path.join(directory, name), "utf8")
        ) as CronTask;
        if (this.insert(task, true)) imported++;
      } catch {
        // A malformed legacy file must not prevent the daemon from starting.
      }
    }
    return imported;
  }

  private insert(task: CronTask, ignoreExisting: boolean): boolean {
    const result = this.runtime.connection.prepare(`
      INSERT ${ignoreExisting ? "OR IGNORE" : ""} INTO scheduler_tasks (
        id, name, cron, command, description, status, created_at, updated_at,
        last_run_at, last_result, last_output
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.name,
      task.cron,
      task.command,
      task.description ?? null,
      task.status,
      task.createdAt,
      task.updatedAt,
      task.lastRunAt ?? null,
      task.lastResult ?? null,
      task.lastOutput ?? null
    );
    return result.changes > 0;
  }

  private fromRow(row: CronTaskRow): CronTask {
    return {
      id: row.id,
      name: row.name,
      cron: row.cron,
      command: row.command,
      description: row.description ?? undefined,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastRunAt: row.last_run_at ?? undefined,
      lastResult: row.last_result ?? undefined,
      lastOutput: row.last_output ?? undefined
    };
  }

  private newId(): string {
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
    return `${timestamp}-${crypto.randomBytes(4).toString("hex")}`;
  }
}
