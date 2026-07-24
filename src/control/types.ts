import type { AuditRecord } from "../observability/audit.js";
import type { MemoryStoreEntry } from "../memory/adapter.js";
import type { TaskRecord, TaskStatus } from "../tasks/store.js";

export type ApprovalKind = "task_review" | "command" | "policy" | "custom";
export type ApprovalRisk = "low" | "medium" | "high";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface ApprovalRequest {
  id: string;
  sourceKey?: string;
  kind: ApprovalKind;
  title: string;
  description?: string;
  requestedBy: string;
  assignedTo: string;
  risk: ApprovalRisk;
  status: ApprovalStatus;
  taskId?: string;
  messageId?: string;
  workflowId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
  notifiedAt?: string;
}

export interface CreateApprovalInput {
  kind?: ApprovalKind;
  title: string;
  description?: string;
  requestedBy: string;
  assignedTo: string;
  risk?: ApprovalRisk;
  taskId?: string;
  messageId?: string;
  workflowId?: string;
  metadata?: Record<string, unknown>;
}

export interface ApprovalDecision {
  decision: "approve" | "reject";
  decidedBy: string;
  note?: string;
}

export interface TaskVisualization {
  total: number;
  active: number;
  byStatus: Record<TaskStatus, number>;
  recent: TaskRecord[];
}

export interface MemoryVisualization {
  total: number;
  byType: Record<string, number>;
  byAgent: Record<string, number>;
  recent: MemoryStoreEntry[];
}

export interface AuditVisualization {
  total: number;
  policyDenials: number;
  byAction: Record<string, number>;
  recent: AuditRecord[];
}

export interface ControlCenterSnapshot {
  generatedAt: string;
  version: string;
  workspaceRoot: string;
  runtime: {
    pid: number;
    uptimeSeconds: number;
    schedulerRunning: boolean;
    scheduledTasks: number;
  };
  approvals: {
    pending: number;
    byRisk: Record<ApprovalRisk, number>;
    items: ApprovalRequest[];
  };
  tasks: TaskVisualization;
  memory: {
    project: MemoryVisualization;
    global: MemoryVisualization;
  };
  audit: AuditVisualization;
}
