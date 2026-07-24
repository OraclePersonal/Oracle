import { describe, expect, test } from "vitest";
import type { ControlCenterSnapshot } from "./types.js";
import { renderControlTui } from "./tui.js";

const snapshot: ControlCenterSnapshot = {
  generatedAt: new Date().toISOString(),
  version: "0.3.0",
  workspaceRoot: "/workspace/oracle",
  runtime: {
    pid: 123,
    uptimeSeconds: 10,
    schedulerRunning: true,
    scheduledTasks: 2
  },
  approvals: {
    pending: 1,
    byRisk: { low: 0, medium: 1, high: 0 },
    items: [{
      id: "approval-1",
      kind: "task_review",
      title: "Review dashboard\u001b[31m",
      requestedBy: "worker",
      assignedTo: "lead",
      risk: "medium",
      status: "pending",
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }]
  },
  tasks: {
    total: 2,
    active: 1,
    byStatus: {
      pending: 0,
      in_progress: 1,
      review: 0,
      done: 1,
      blocked: 0,
      cancelled: 0
    },
    recent: []
  },
  memory: {
    project: { total: 3, byType: { insight: 3 }, byAgent: { worker: 3 }, recent: [] },
    global: { total: 1, byType: { fact: 1 }, byAgent: { oracle: 1 }, recent: [] }
  },
  audit: {
    total: 1,
    policyDenials: 0,
    byAction: { tool: 1 },
    recent: []
  }
};

describe("Control Center TUI", () => {
  test("renders all visualization sections and strips terminal control input", () => {
    const output = renderControlTui(snapshot, 0, 100);
    expect(output).toContain("ORACLE CONTROL CENTER");
    expect(output).toContain("TASK WORKFLOW");
    expect(output).toContain("APPROVAL INBOX");
    expect(output).toContain("MEMORY");
    expect(output).toContain("AUDIT");
    expect(output).not.toContain("dashboard\u001b[31m");
  });
});
