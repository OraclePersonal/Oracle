import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export type CronTaskStatus = "active" | "paused" | "deleted";

export interface CronTask {
  id: string;
  name: string;
  cron: string;
  command: string;
  description?: string;
  status: CronTaskStatus;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastResult?: "success" | "error";
  lastOutput?: string;
}

export interface CreateTaskInput {
  name: string;
  cron: string;
  command: string;
  description?: string;
}

export interface UpdateTaskInput {
  name?: string;
  cron?: string;
  command?: string;
  description?: string;
  status?: CronTaskStatus;
}

export interface CronTaskRepository {
  create(input: CreateTaskInput): Promise<CronTask>;
  get(id: string): Promise<CronTask | null>;
  list(): Promise<CronTask[]>;
  update(id: string, input: UpdateTaskInput): Promise<CronTask | null>;
  delete(id: string): Promise<boolean>;
  recordRun(id: string, result: "success" | "error", output: string): Promise<void>;
}

export class CronTaskStore implements CronTaskRepository {
  constructor(private readonly homeDir: string) {}

  private dir(): string {
    return path.join(this.homeDir, "scheduler");
  }

  private filePath(id: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(id)) {
      throw new Error(`Invalid task id "${id}".`);
    }
    return path.join(this.dir(), `${id}.json`);
  }

  private newId(): string {
    const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
    return `${ts}-${crypto.randomBytes(4).toString("hex")}`;
  }

  async create(input: CreateTaskInput): Promise<CronTask> {
    await fs.mkdir(this.dir(), { recursive: true });
    const now = new Date().toISOString();
    const task: CronTask = {
      id: this.newId(),
      name: input.name,
      cron: input.cron,
      command: input.command,
      description: input.description,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    await this.writeAtomic(this.filePath(task.id), task);
    return task;
  }

  async get(id: string): Promise<CronTask | null> {
    try {
      const raw = await fs.readFile(this.filePath(id), "utf8");
      return JSON.parse(raw) as CronTask;
    } catch {
      return null;
    }
  }

  async list(): Promise<CronTask[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir());
    } catch {
      return [];
    }
    const ids = entries.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length));
    const tasks = await Promise.all(ids.map((id) => this.get(id)));
    return tasks.filter((t): t is CronTask => t !== null);
  }

  async update(id: string, input: UpdateTaskInput): Promise<CronTask | null> {
    const task = await this.get(id);
    if (!task) return null;
    if (input.name !== undefined) task.name = input.name;
    if (input.cron !== undefined) task.cron = input.cron;
    if (input.command !== undefined) task.command = input.command;
    if (input.description !== undefined) task.description = input.description;
    if (input.status !== undefined) task.status = input.status;
    task.updatedAt = new Date().toISOString();
    await this.writeAtomic(this.filePath(id), task);
    return task;
  }

  async delete(id: string): Promise<boolean> {
    try {
      await fs.rm(this.filePath(id));
      return true;
    } catch {
      return false;
    }
  }

  async recordRun(id: string, result: "success" | "error", output: string): Promise<void> {
    const task = await this.get(id);
    if (!task) return;
    task.lastRunAt = new Date().toISOString();
    task.lastResult = result;
    task.lastOutput = output.slice(0, 4000);
    task.updatedAt = new Date().toISOString();
    await this.writeAtomic(this.filePath(id), task);
  }

  private async writeAtomic(filePath: string, task: CronTask): Promise<void> {
    const tmp = `${filePath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(task, null, 2), "utf8");
    await fs.rename(tmp, filePath);
  }
}
