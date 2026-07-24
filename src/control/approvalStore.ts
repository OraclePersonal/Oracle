import crypto from "node:crypto";
import type { RuntimeDatabase } from "../runtime/database.js";
import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalRequest,
  ApprovalRisk,
  ApprovalStatus,
  CreateApprovalInput
} from "./types.js";

interface ApprovalRow {
  id: string;
  source_key: string | null;
  kind: ApprovalKind;
  title: string;
  description: string | null;
  requested_by: string;
  assigned_to: string;
  risk: ApprovalRisk;
  status: ApprovalStatus;
  task_id: string | null;
  message_id: string | null;
  workflow_id: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
  notified_at: string | null;
}

export class ApprovalStore {
  constructor(private readonly runtime: RuntimeDatabase) {}

  create(input: CreateApprovalInput): ApprovalRequest {
    return this.insert({
      ...input,
      kind: input.kind ?? "custom",
      risk: input.risk ?? "medium"
    });
  }

  ensureTaskReview(input: {
    taskId: string;
    reviewKey: string;
    title: string;
    description?: string;
    requestedBy: string;
    assignedTo: string;
    messageId?: string;
    workflowId?: string;
  }): { approval: ApprovalRequest; created: boolean } {
    const sourceKey = `task:${input.taskId}:${input.reviewKey}`;
    const existing = this.getBySourceKey(sourceKey);
    if (existing) {
      if (existing.status !== "pending") {
        const now = new Date().toISOString();
        this.runtime.connection.prepare(`
          UPDATE approval_requests
          SET status = 'pending', title = ?, description = ?, requested_by = ?,
              assigned_to = ?, message_id = ?, workflow_id = ?, updated_at = ?, decided_at = NULL,
              decided_by = NULL, decision_note = NULL, notified_at = NULL
          WHERE id = ?
        `).run(
          input.title,
          input.description ?? null,
          input.requestedBy,
          input.assignedTo,
          input.messageId ?? null,
          input.workflowId ?? null,
          now,
          existing.id
        );
        return { approval: this.get(existing.id)!, created: true };
      }
      return { approval: existing, created: false };
    }
    return {
      approval: this.insert({
        ...input,
        sourceKey,
        kind: "task_review",
        risk: "medium"
      }),
      created: true
    };
  }

  get(id: string): ApprovalRequest | null {
    const row = this.runtime.connection.prepare(
      "SELECT * FROM approval_requests WHERE id = ?"
    ).get(id) as ApprovalRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  getBySourceKey(sourceKey: string): ApprovalRequest | null {
    const row = this.runtime.connection.prepare(
      "SELECT * FROM approval_requests WHERE source_key = ?"
    ).get(sourceKey) as ApprovalRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  list(options: { status?: ApprovalStatus; limit?: number } = {}): ApprovalRequest[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const rows = options.status
      ? this.runtime.connection.prepare(`
          SELECT * FROM approval_requests
          WHERE status = ?
          ORDER BY created_at DESC
          LIMIT ?
        `).all(options.status, limit)
      : this.runtime.connection.prepare(`
          SELECT * FROM approval_requests
          ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC
          LIMIT ?
        `).all(limit);
    return (rows as unknown as ApprovalRow[]).map((row) => this.fromRow(row));
  }

  decide(id: string, decision: ApprovalDecision): ApprovalRequest | null {
    const status: ApprovalStatus = decision.decision === "approve" ? "approved" : "rejected";
    const now = new Date().toISOString();
    const result = this.runtime.connection.prepare(`
      UPDATE approval_requests
      SET status = ?, decided_at = ?, decided_by = ?, decision_note = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(status, now, decision.decidedBy, decision.note ?? null, now, id);
    if (result.changes === 0) return null;
    return this.get(id);
  }

  reconcile(id: string, status: Exclude<ApprovalStatus, "pending">, note?: string): ApprovalRequest | null {
    const current = this.get(id);
    if (!current || current.status !== "pending") return current;
    const now = new Date().toISOString();
    this.runtime.connection.prepare(`
      UPDATE approval_requests
      SET status = ?, decided_at = ?, decided_by = 'runtime-recovery',
          decision_note = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(status, now, note ?? null, now, id);
    return this.get(id);
  }

  markNotified(id: string): ApprovalRequest | null {
    const now = new Date().toISOString();
    this.runtime.connection.prepare(`
      UPDATE approval_requests
      SET notified_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, id);
    return this.get(id);
  }

  private insert(input: CreateApprovalInput & {
    kind: ApprovalKind;
    risk: ApprovalRisk;
    sourceKey?: string;
  }): ApprovalRequest {
    const now = new Date().toISOString();
    const id = this.newId();
    this.runtime.connection.prepare(`
      INSERT INTO approval_requests (
        id, source_key, kind, title, description, requested_by, assigned_to,
        risk, status, task_id, message_id, workflow_id, metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.sourceKey ?? null,
      input.kind,
      input.title,
      input.description ?? null,
      input.requestedBy,
      input.assignedTo,
      input.risk,
      input.taskId ?? null,
      input.messageId ?? null,
      input.workflowId ?? null,
      JSON.stringify(input.metadata ?? {}),
      now,
      now
    );
    return this.get(id)!;
  }

  private newId(): string {
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
    return `approval-${timestamp}-${crypto.randomBytes(4).toString("hex")}`;
  }

  private fromRow(row: ApprovalRow): ApprovalRequest {
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
    return {
      id: row.id,
      sourceKey: row.source_key ?? undefined,
      kind: row.kind,
      title: row.title,
      description: row.description ?? undefined,
      requestedBy: row.requested_by,
      assignedTo: row.assigned_to,
      risk: row.risk,
      status: row.status,
      taskId: row.task_id ?? undefined,
      messageId: row.message_id ?? undefined,
      workflowId: row.workflow_id ?? undefined,
      metadata,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      decidedAt: row.decided_at ?? undefined,
      decidedBy: row.decided_by ?? undefined,
      decisionNote: row.decision_note ?? undefined,
      notifiedAt: row.notified_at ?? undefined
    };
  }
}
