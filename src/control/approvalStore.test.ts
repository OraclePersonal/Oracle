import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RuntimeDatabase } from "../runtime/database.js";
import { ApprovalStore } from "./approvalStore.js";

let home: string;
let database: RuntimeDatabase;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-approval-store-"));
  database = new RuntimeDatabase(home);
});

afterEach(async () => {
  database.close();
  await fs.rm(home, { recursive: true, force: true });
});

describe("ApprovalStore", () => {
  test("persists approval requests and decisions in SQLite", () => {
    const store = new ApprovalStore(database);
    const approval = store.create({
      kind: "command",
      title: "Deploy release",
      requestedBy: "agent",
      assignedTo: "lead",
      risk: "high",
      metadata: { environment: "production" }
    });
    expect(store.list({ status: "pending" })).toHaveLength(1);
    expect(store.decide(approval.id, {
      decision: "approve",
      decidedBy: "lead",
      note: "Verified"
    })).toMatchObject({
      status: "approved",
      decidedBy: "lead",
      decisionNote: "Verified"
    });

    database.close();
    database = new RuntimeDatabase(home);
    expect(new ApprovalStore(database).get(approval.id)).toMatchObject({
      title: "Deploy release",
      status: "approved",
      metadata: { environment: "production" }
    });
  });

  test("creates one approval per task review cycle", () => {
    const store = new ApprovalStore(database);
    const first = store.ensureTaskReview({
      taskId: "task-1",
      reviewKey: "2026-07-24T01:00:00.000Z",
      title: "Review task",
      requestedBy: "worker",
      assignedTo: "lead"
    });
    const duplicate = store.ensureTaskReview({
      taskId: "task-1",
      reviewKey: "2026-07-24T01:00:00.000Z",
      title: "Review task",
      requestedBy: "worker",
      assignedTo: "lead"
    });
    store.decide(first.approval.id, { decision: "reject", decidedBy: "lead" });
    const secondCycle = store.ensureTaskReview({
      taskId: "task-1",
      reviewKey: "2026-07-24T02:00:00.000Z",
      title: "Review task again",
      requestedBy: "worker",
      assignedTo: "lead"
    });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(secondCycle.created).toBe(true);
    expect(secondCycle.approval.id).not.toBe(first.approval.id);
  });
});
