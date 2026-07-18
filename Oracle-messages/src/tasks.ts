import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Task, TaskStatus } from "./types.js";

/**
 * JSONL-backed task store.
 * Tasks follow a lifecycle: pending → assigned → in_progress → completed/failed/cancelled.
 */
export class TaskStore {
  constructor(private readonly rootDir: string) {}

  async createTask(input: {
    title: string;
    description: string;
    sender: string;
    assignee?: string;
    meta?: Record<string, unknown>;
  }): Promise<Task> {
    const now = new Date().toISOString();
    const task: Task = {
      id: `${Date.now()}-${crypto.randomUUID()}`,
      title: input.title,
      description: input.description,
      status: "pending",
      assignee: input.assignee,
      sender: input.sender,
      created_at: now,
      updated_at: now,
      meta: input.meta,
    };
    await this.append("tasks.jsonl", task);
    return task;
  }

  async transitionTask(taskId: string, status: TaskStatus, assignee?: string): Promise<Task> {
    const all = await this.readLog<Task>("tasks.jsonl");
    const task = all.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    task.status = status;
    task.updated_at = new Date().toISOString();
    if (assignee) task.assignee = assignee;
    // Remove old, append new
    const remaining = all.filter((t) => t.id !== taskId);
    remaining.push(task);
    await this.writeLog("tasks.jsonl", remaining);
    return task;
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    return (await this.readLog<Task>("tasks.jsonl")).find((t) => t.id === taskId);
  }

  async listTasks(filter?: {
    status?: TaskStatus;
    assignee?: string;
    sender?: string;
    limit?: number;
  }): Promise<Task[]> {
    let tasks = await this.readLog<Task>("tasks.jsonl");
    if (filter?.status) tasks = tasks.filter((t) => t.status === filter.status);
    if (filter?.assignee) tasks = tasks.filter((t) => t.assignee === filter.assignee);
    if (filter?.sender) tasks = tasks.filter((t) => t.sender === filter.sender);
    tasks.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return tasks.slice(0, filter?.limit ?? 100);
  }

  private async append(file: string, value: unknown): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.appendFile(path.join(this.rootDir, file), `${JSON.stringify(value)}\n`, "utf8");
  }

  private async readLog<T>(file: string): Promise<T[]> {
    try {
      const data = await fs.readFile(path.join(this.rootDir, file), "utf8");
      return data.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as T; } catch { return null; } }).filter(Boolean) as T[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeLog<T>(file: string, entries: T[]): Promise<void> {
    const dest = path.join(this.rootDir, file);
    const tmp = dest + ".tmp";
    await fs.writeFile(tmp, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    await fs.rename(tmp, dest);
  }
}
