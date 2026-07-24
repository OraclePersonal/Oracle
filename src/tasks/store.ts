import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  ConsensusEngine,
  type TaskProposal,
  type VoteDecision
} from "./consensus.js";

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

export type TaskCoordinationEventType =
  | "task_assigned"
  | "task_submitted"
  | "task_approved"
  | "task_rejected"
  | "consensus_decided";

export interface TaskCoordinationEvent {
  id: string;
  type: TaskCoordinationEventType;
  from: string;
  to: string;
  subject: string;
  body: string;
  status: "pending" | "sent";
  createdAt: string;
  sentAt?: string;
  messageId?: string;
  workflowId?: string;
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
  proposals: TaskProposal[];
  messageIds: string[];
  coordinationEvents: TaskCoordinationEvent[];
  workflowId?: string;
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

  private newCoordinationEvent(
    task: Pick<TaskRecord, "id" | "workflowId">,
    event: Omit<TaskCoordinationEvent, "id" | "status" | "createdAt" | "workflowId">
  ): TaskCoordinationEvent {
    return {
      ...event,
      id: `event-${crypto.randomBytes(8).toString("hex")}`,
      status: "pending",
      createdAt: new Date().toISOString(),
      workflowId: task.workflowId
    };
  }

  async create(opts: {
    title: string;
    description?: string;
    createdBy: string;
    assignee: string;
    checklist?: string[];
    parentId?: string;
    workflowId?: string;
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
      proposals: [],
      messageIds: [],
      coordinationEvents: [],
      workflowId: opts.workflowId,
      parentId: opts.parentId,
      createdAt: now,
      updatedAt: now
    };
    record.coordinationEvents.push(this.newCoordinationEvent(record, {
      type: "task_assigned",
      from: record.createdBy,
      to: record.assignee,
      subject: `Task assigned: ${record.title}`,
      body: `New task ${record.id}: ${record.title}${record.description ? `\n${record.description}` : ""}${
        record.checklist.length
          ? `\nChecklist:\n- ${record.checklist.map((item) => item.text).join("\n- ")}`
          : ""
      }\nUse oracle_task_update to track progress, oracle_task_submit when done.`
    }));
    await this.writeAtomic(this.filePath(record.id), record);
    return record;
  }

  async get(id: string): Promise<TaskRecord | null> {
    try {
      const task = JSON.parse(await fs.readFile(this.filePath(id), "utf8")) as TaskRecord;
      if (!Array.isArray(task.checklist)) task.checklist = [];
      if (!Array.isArray(task.notes)) task.notes = [];
      if (!Array.isArray(task.proposals)) task.proposals = [];
      if (!Array.isArray(task.messageIds)) task.messageIds = [];
      if (!Array.isArray(task.coordinationEvents)) task.coordinationEvents = [];
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

  async list(opts: {
    assignee?: string;
    createdBy?: string;
    status?: TaskStatus;
    activeOnly?: boolean;
    workflowId?: string;
  } = {}): Promise<TaskRecord[]> {
    const all = await this.readAll();
    return all
      .filter((t) => (opts.assignee ? t.assignee === opts.assignee : true))
      .filter((t) => (opts.createdBy ? t.createdBy === opts.createdBy : true))
      .filter((t) => (opts.status ? t.status === opts.status : true))
      .filter((t) => (opts.activeOnly ? ACTIVE_STATUSES.includes(t.status) : true))
      .filter((t) => (opts.workflowId ? t.workflowId === opts.workflowId : true))
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
    task.coordinationEvents.push(this.newCoordinationEvent(task, {
      type: "task_submitted",
      from: agent,
      to: task.createdBy,
      subject: `Task ready for review: ${task.title}`,
      body: `Task ${task.id} submitted by ${agent}.\n${summary}\nUse oracle_task_get to see the checklist and notes, then oracle_task_close to approve or send back.`
    }));
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
    task.coordinationEvents.push(this.newCoordinationEvent(task, {
      type: approved ? "task_approved" : "task_rejected",
      from: agent,
      to: task.assignee,
      subject: approved ? `Task approved: ${task.title}` : `Task sent back: ${task.title}`,
      body: approved
        ? `Task ${task.id} approved and closed.${note ? ` ${note}` : ""}`
        : `Task ${task.id} needs more work: ${note ?? "see notes"}`
    }));
    task.updatedAt = new Date().toISOString();
    await this.writeAtomic(this.filePath(id), task);
    return task;
  }

  async createProposal(
    taskId: string,
    proposerAgentId: string,
    proposedAction: string,
    options: { requiredQuorum?: number; approvalThresholdRatio?: number } = {}
  ): Promise<TaskProposal> {
    const task = await this.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const proposal = new ConsensusEngine().createProposal({
      taskId,
      proposerAgentId,
      proposedAction,
      requiredQuorum: options.requiredQuorum,
      approvalThresholdRatio: options.approvalThresholdRatio
    });
    task.proposals.push(proposal);
    task.updatedAt = new Date().toISOString();
    await this.writeAtomic(this.filePath(task.id), task);
    return proposal;
  }

  async castProposalVote(
    proposalId: string,
    agentId: string,
    decision: VoteDecision,
    justification: string
  ): Promise<{ task: TaskRecord; proposal: TaskProposal } | null> {
    for (const task of await this.readAll()) {
      const proposal = task.proposals.find((candidate) => candidate.id === proposalId);
      if (!proposal) continue;
      const previousStatus = proposal.status;
      const updated = new ConsensusEngine().castVote(proposal, agentId, decision, justification);
      if (previousStatus === "pending" && updated.status !== "pending") {
        task.coordinationEvents.push(this.newCoordinationEvent(task, {
          type: "consensus_decided",
          from: agentId,
          to: task.createdBy,
          subject: `Consensus ${updated.status}: ${task.title}`,
          body: `Proposal ${updated.id} for task ${task.id} was ${updated.status} after ${updated.votes.length} vote(s).\n${updated.proposedAction}`
        }));
      }
      task.updatedAt = new Date().toISOString();
      await this.writeAtomic(this.filePath(task.id), task);
      return { task, proposal: updated };
    }
    return null;
  }

  /** Add or replace a proposal while preserving TaskStore as the source of truth. */
  async upsertProposal(taskId: string, proposal: TaskProposal): Promise<TaskRecord> {
    const task = await this.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const normalized = { ...proposal, taskId, votes: [...proposal.votes] };
    const index = task.proposals.findIndex((candidate) => candidate.id === proposal.id);
    if (index >= 0) task.proposals[index] = normalized;
    else task.proposals.push(normalized);
    task.updatedAt = new Date().toISOString();
    await this.writeAtomic(this.filePath(taskId), task);
    return task;
  }

  async pendingCoordinationEvents(taskId?: string): Promise<Array<{ task: TaskRecord; event: TaskCoordinationEvent }>> {
    const tasks = taskId
      ? [await this.get(taskId)].filter((task): task is TaskRecord => task !== null)
      : await this.readAll();
    return tasks.flatMap((task) =>
      task.coordinationEvents
        .filter((event) => event.status === "pending")
        .map((event) => ({ task, event }))
    );
  }

  async markCoordinationEventSent(taskId: string, eventId: string, messageId: string): Promise<TaskRecord> {
    const task = await this.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const event = task.coordinationEvents.find((candidate) => candidate.id === eventId);
    if (!event) throw new Error(`Coordination event not found: ${eventId}`);
    event.status = "sent";
    event.sentAt = new Date().toISOString();
    event.messageId = messageId;
    if (!task.messageIds.includes(messageId)) task.messageIds.push(messageId);
    task.updatedAt = new Date().toISOString();
    await this.writeAtomic(this.filePath(taskId), task);
    return task;
  }
}
