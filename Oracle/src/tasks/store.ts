import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Task tracking for multi-agent work: a lead breaks work into tasks, assigns
 * them, agents record progress notes and check off a verification checklist,
 * then submit for review. Mirrors the message store's design (one atomic
 * JSON file per task under ~/.oracle/tasks/) so it needs no database and
 * composes naturally with the message bus for reporting.
 */

export type TaskStatus = "pending" | "in_progress" | "review" | "done" | "blocked" | "cancelled";

export interface ChecklistItem {
  text: string;
  done: boolean;
}

export interface TaskNote {
  ts: string;
  agent: string;
  text: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  description?: string;
  createdBy: string;
  assignee: string;
  status: TaskStatus;
  checklist: ChecklistItem[];
  notes: TaskNote[];
  parentId?: string;
  createdAt: string;
  updatedAt: string;
}

const ACTIVE_STATUSES: TaskStatus[] = ["pending", "in_progress", "review", "blocked"];

export class TaskStore {
  constructor(private readonly homeDir: string) {}

  private dir(): string {
    return path.join(this.homeDir, "tasks");
  }

  private filePath(id: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(id)) {
      throw new Error(`Invalid task id "${id}".`);
    }
    return path.join(this.dir(), `${id}.json`);
  }

  private async writeAtomic(filePath: string, record: TaskRecord): Promise<void> {
    const tmp = `${filePath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
    await fs.rename(tmp, filePath);
  }

  private newId(): string {
    const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
    return `${ts}-${crypto.randomBytes(4).toString("hex")}`;
  }

  async create(opts: {
    title: string;
    description?: string;
    createdBy: string;
    assignee: string;
    checklist?: string[];
    parentId?: string;
  }): Promise<TaskRecord> {
    await fs.mkdir(this.dir(), { recursive: true });
    const now = new Date().toISOString();
    const record: TaskRecord = {
      id: this.newId(),
      title: opts.title,
      description: opts.description,
      createdBy: opts.createdBy,
      assignee: opts.assignee,
      status: "pending",
      checklist: (opts.checklist ?? []).map((text) => ({ text, done: false })),
      notes: [],
      parentId: opts.parentId,
      createdAt: now,
      updatedAt: now
    };
    await this.writeAtomic(this.filePath(record.id), record);
    return record;
  }

  async get(id: string): Promise<TaskRecord | null> {
    try {
      const task = JSON.parse(await fs.readFile(this.filePath(id), "utf8")) as TaskRecord;
      if (!Array.isArray(task.checklist)) task.checklist = [];
      if (!Array.isArray(task.notes)) task.notes = [];
      return task;
    } catch {
      return null;
    }
  }

  private async readAll(): Promise<TaskRecord[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir());
    } catch {
      return [];
    }
    const ids = entries.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length));
    const tasks = await Promise.all(ids.map((id) => this.get(id)));
    return tasks.filter((t): t is TaskRecord => t !== null);
  }

  async list(opts: { assignee?: string; createdBy?: string; status?: TaskStatus; activeOnly?: boolean } = {}): Promise<TaskRecord[]> {
    const all = await this.readAll();
    return all
      .filter((t) => (opts.assignee ? t.assignee === opts.assignee : true))
      .filter((t) => (opts.createdBy ? t.createdBy === opts.createdBy : true))
      .filter((t) => (opts.status ? t.status === opts.status : true))
      .filter((t) => (opts.activeOnly ? ACTIVE_STATUSES.includes(t.status) : true))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  /** Append a progress note and optionally change status. Any agent may call this. */
  async update(id: string, agent: string, opts: { status?: TaskStatus; note?: string }): Promise<TaskRecord | null> {
    this.filePath(id); // validates id before any fs access
    const task = await this.get(id);
    if (!task) return null;
    if (opts.note) task.notes.push({ ts: new Date().toISOString(), agent, text: opts.note });
    if (opts.status) task.status = opts.status;
    task.updatedAt = new Date().toISOString();
    await this.writeAtomic(this.filePath(id), task);
    return task;
  }

  /** Check or uncheck one checklist item by index. */
  async setChecklistItem(id: string, index: number, done: boolean): Promise<TaskRecord | null> {
    const task = await this.get(id);
    if (!task || !task.checklist[index]) return null;
    task.checklist[index].done = done;
    task.updatedAt = new Date().toISOString();
    await this.writeAtomic(this.filePath(id), task);
    return task;
  }

  /**
   * Move a task to "review" — the verification gate. Fails if any checklist
   * item is unchecked, so a task can't be reported done without its
   * declared verification steps actually having been done.
   */
  async submitForReview(id: string, agent: string, summary: string): Promise<TaskRecord> {
    const task = await this.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    const unchecked = task.checklist.filter((c) => !c.done);
    if (unchecked.length > 0) {
      throw new Error(
        `Cannot submit — ${unchecked.length} checklist item(s) unchecked: ${unchecked.map((c) => c.text).join("; ")}`
      );
    }
    task.status = "review";
    task.notes.push({ ts: new Date().toISOString(), agent, text: `Submitted for review: ${summary}` });
    task.updatedAt = new Date().toISOString();
    await this.writeAtomic(this.filePath(id), task);
    return task;
  }

  /** Lead/creator closes a task: approve (done) or reject (bounces back to in_progress). */
  async close(id: string, agent: string, approved: boolean, note?: string): Promise<TaskRecord> {
    const task = await this.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    task.status = approved ? "done" : "in_progress";
    task.notes.push({
      ts: new Date().toISOString(),
      agent,
      text: approved ? `Approved and closed.${note ? ` ${note}` : ""}` : `Sent back: ${note ?? "needs more work"}`
    });
    task.updatedAt = new Date().toISOString();
    await this.writeAtomic(this.filePath(id), task);
    return task;
  }
}
