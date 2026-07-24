import { CoordinationService } from "../coordination/service.js";
import { MemoryAdapter, type MemoryStoreEntry } from "../memory/adapter.js";
import { MessageStore } from "../messaging/store.js";
import { AuditLogger, type AuditRecord } from "../observability/audit.js";
import { SwarmStore } from "../orchestrator/swarmStore.js";
import type { RuntimeDatabase } from "../runtime/database.js";
import type { RuntimeEventBus } from "../runtime/events.js";
import type { SchedulerService } from "../runtime/schedulerService.js";
import { TaskStore, type TaskRecord, type TaskStatus } from "../tasks/store.js";
import { VERSION } from "../version.js";
import { ApprovalStore } from "./approvalStore.js";
import { TelegramApprovalNotifier } from "./telegram.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRisk,
  AuditVisualization,
  ControlCenterSnapshot,
  CreateApprovalInput,
  MemoryVisualization,
  TaskVisualization
} from "./types.js";

const TASK_STATUSES: TaskStatus[] = [
  "pending",
  "in_progress",
  "review",
  "done",
  "blocked",
  "cancelled"
];

const ACTIVE_TASK_STATUSES = new Set<TaskStatus>([
  "pending",
  "in_progress",
  "review",
  "blocked"
]);

export class ControlCenterService {
  readonly approvals: ApprovalStore;
  private readonly tasks: TaskStore;
  private readonly coordination: CoordinationService;
  private readonly projectMemory: MemoryAdapter;
  private readonly globalMemory: MemoryAdapter;
  private readonly audit = new AuditLogger();

  constructor(
    database: RuntimeDatabase,
    private readonly events: RuntimeEventBus,
    private readonly scheduler: SchedulerService,
    private readonly options: {
      homeDir: string;
      workspaceRoot: string;
      telegram?: TelegramApprovalNotifier;
    }
  ) {
    this.approvals = new ApprovalStore(database);
    this.tasks = new TaskStore(options.homeDir);
    this.coordination = new CoordinationService(
      this.tasks,
      new MessageStore(options.homeDir),
      new SwarmStore(options.homeDir)
    );
    this.projectMemory = new MemoryAdapter(options.workspaceRoot);
    this.globalMemory = new MemoryAdapter(options.homeDir, "memory");
  }

  async snapshot(): Promise<ControlCenterSnapshot> {
    await this.syncTaskApprovals();
    const [tasks, projectStats, projectRecent, globalStats, globalRecent, audits, schedules] =
      await Promise.all([
        this.tasks.list(),
        this.projectMemory.getStats(),
        this.projectMemory.recall({ limit: 12, touch: false }),
        this.globalMemory.getStats(),
        this.globalMemory.recall({ limit: 12, touch: false }),
        this.audit.readRecords(this.options.workspaceRoot, 200),
        this.scheduler.list()
      ]);
    const pending = this.approvals.list({ status: "pending", limit: 100 });
    return {
      generatedAt: new Date().toISOString(),
      version: VERSION,
      workspaceRoot: this.options.workspaceRoot,
      runtime: {
        pid: process.pid,
        uptimeSeconds: Math.floor(process.uptime()),
        schedulerRunning: this.scheduler.isRunning,
        scheduledTasks: schedules.length
      },
      approvals: {
        pending: pending.length,
        byRisk: this.countApprovalRisk(pending),
        items: pending
      },
      tasks: this.taskVisualization(tasks),
      memory: {
        project: this.memoryVisualization(projectStats, projectRecent),
        global: this.memoryVisualization(globalStats, globalRecent)
      },
      audit: this.auditVisualization(audits)
    };
  }

  async listApprovals(status?: "pending" | "approved" | "rejected" | "cancelled"): Promise<ApprovalRequest[]> {
    await this.syncTaskApprovals();
    return this.approvals.list({ status, limit: 200 });
  }

  getApproval(id: string): ApprovalRequest | null {
    return this.approvals.get(id);
  }

  async createApproval(input: CreateApprovalInput): Promise<ApprovalRequest> {
    if (input.kind === "task_review") {
      throw new Error("task_review approvals are created automatically when a task enters review.");
    }
    const approval = this.approvals.create(input);
    this.events.publish("approval.requested", {
      approvalId: approval.id,
      kind: approval.kind,
      risk: approval.risk,
      assignedTo: approval.assignedTo,
      taskId: approval.taskId
    });
    await this.notify(approval);
    await this.logDecision("requested", approval, input.requestedBy);
    return approval;
  }

  async decide(id: string, decision: ApprovalDecision): Promise<ApprovalRequest> {
    const approval = this.approvals.get(id);
    if (!approval) throw new Error(`Approval not found: ${id}`);
    if (approval.status !== "pending") {
      throw new Error(`Approval ${id} is already ${approval.status}.`);
    }

    if (approval.kind === "task_review" && approval.taskId) {
      const task = await this.tasks.get(approval.taskId);
      if (!task) throw new Error(`Linked task not found: ${approval.taskId}`);
      if (task.status !== "review") {
        const reconciled = this.reconcileFromTask(approval, task);
        if (reconciled) return reconciled;
        throw new Error(`Linked task ${task.id} is ${task.status}, not review.`);
      }
      await this.coordination.closeTask(
        task.id,
        decision.decidedBy,
        decision.decision === "approve",
        decision.note
      );
    }

    const updated = this.approvals.decide(id, decision);
    if (!updated) throw new Error(`Approval ${id} changed before the decision was recorded.`);
    this.events.publish(
      decision.decision === "approve" ? "approval.approved" : "approval.rejected",
      {
        approvalId: updated.id,
        decidedBy: decision.decidedBy,
        taskId: updated.taskId,
        note: decision.note
      }
    );
    await this.logDecision(decision.decision, updated, decision.decidedBy, decision.note);
    return updated;
  }

  async syncTaskApprovals(): Promise<void> {
    const tasks = await this.tasks.list();
    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (const task of tasks.filter((candidate) => candidate.status === "review")) {
      const reviewKey = [...task.notes]
        .reverse()
        .find((note) => note.text.startsWith("Submitted for review:"))?.ts
        ?? task.updatedAt;
      const ensured = this.approvals.ensureTaskReview({
        taskId: task.id,
        reviewKey,
        title: `Review: ${task.title}`,
        description: task.notes.at(-1)?.text ?? task.description,
        requestedBy: task.assignee,
        assignedTo: task.createdBy,
        messageId: task.messageIds.at(-1),
        workflowId: task.workflowId
      });
      if (ensured.created) {
        this.events.publish("approval.requested", {
          approvalId: ensured.approval.id,
          kind: "task_review",
          risk: ensured.approval.risk,
          assignedTo: ensured.approval.assignedTo,
          taskId: task.id
        });
        await this.notify(ensured.approval);
        await this.logDecision("requested", ensured.approval, task.assignee);
      }
    }

    for (const approval of this.approvals.list({ status: "pending", limit: 1000 })) {
      if (approval.kind !== "task_review" || !approval.taskId) continue;
      const task = byId.get(approval.taskId);
      if (!task) {
        this.approvals.reconcile(approval.id, "cancelled", "Linked task no longer exists.");
        continue;
      }
      if (task.status !== "review") this.reconcileFromTask(approval, task);
    }
  }

  private reconcileFromTask(approval: ApprovalRequest, task: TaskRecord): ApprovalRequest | null {
    if (task.status === "done") {
      return this.approvals.reconcile(
        approval.id,
        "approved",
        "Recovered from linked task state."
      );
    }
    if (
      task.status === "in_progress"
      && task.notes.at(-1)?.text.toLowerCase().startsWith("sent back:")
    ) {
      return this.approvals.reconcile(
        approval.id,
        "rejected",
        "Recovered from linked task state."
      );
    }
    if (task.status !== "review") {
      return this.approvals.reconcile(
        approval.id,
        "cancelled",
        `Linked task moved to ${task.status}.`
      );
    }
    return null;
  }

  private async notify(approval: ApprovalRequest): Promise<void> {
    const notifier = this.options.telegram ?? new TelegramApprovalNotifier();
    if (!notifier.enabled || approval.notifiedAt) return;
    try {
      if (await notifier.notify(approval)) this.approvals.markNotified(approval.id);
    } catch (error) {
      this.events.publish("approval.notification.failed", {
        approvalId: approval.id,
        channel: "telegram",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private taskVisualization(tasks: TaskRecord[]): TaskVisualization {
    const byStatus = Object.fromEntries(
      TASK_STATUSES.map((status) => [status, 0])
    ) as Record<TaskStatus, number>;
    for (const task of tasks) byStatus[task.status]++;
    return {
      total: tasks.length,
      active: tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status)).length,
      byStatus,
      recent: [...tasks]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 20)
    };
  }

  private memoryVisualization(
    stats: { total: number; byType: Record<string, number>; byAgent: Record<string, number> },
    recent: MemoryStoreEntry[]
  ): MemoryVisualization {
    return { ...stats, recent };
  }

  private auditVisualization(records: AuditRecord[]): AuditVisualization {
    const byAction: Record<string, number> = {};
    for (const record of records) {
      byAction[record.action] = (byAction[record.action] ?? 0) + 1;
    }
    return {
      total: records.length,
      policyDenials: records.filter((record) => record.action === "policy_denied").length,
      byAction,
      recent: records.slice(0, 30)
    };
  }

  private countApprovalRisk(approvals: ApprovalRequest[]): Record<ApprovalRisk, number> {
    const counts: Record<ApprovalRisk, number> = { low: 0, medium: 0, high: 0 };
    for (const approval of approvals) counts[approval.risk]++;
    return counts;
  }

  private async logDecision(
    action: string,
    approval: ApprovalRequest,
    actor: string,
    note?: string
  ): Promise<void> {
    await this.audit.log(this.options.workspaceRoot, {
      action: "tool",
      target: `approval:${approval.id}`,
      agentId: actor,
      details: {
        controlCenterAction: action,
        approvalKind: approval.kind,
        risk: approval.risk,
        taskId: approval.taskId,
        note
      }
    });
  }
}
