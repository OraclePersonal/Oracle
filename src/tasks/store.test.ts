import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { TaskStore } from "./store.js";
import { formatTaskBoard } from "../mcp/taskTools.js";

let home: string;
let store: TaskStore;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-tasks-"));
  store = new TaskStore(home);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("TaskStore", () => {
  test("formats an ASCII board with named agents and main TODOs", () => {
    const board = formatTaskBoard(
      [{ name: "claude-lead", role: "lead", active: true }, { name: "codex-content-1", role: "content", active: false }],
      [{ id: "task-1", title: "Draft launch copy", assignee: "codex-content-1", createdBy: "claude-lead", status: "pending" }]
    );
    expect(board).toContain("claude-lead");
    expect(board).toContain("codex-content-1");
    expect(board).toContain("Draft launch copy");
  });
  test("create then list filters by assignee and status", async () => {
    await store.create({ title: "A", createdBy: "lead", assignee: "worker" });
    await store.create({ title: "B", createdBy: "lead", assignee: "other" });
    const forWorker = await store.list({ assignee: "worker" });
    expect(forWorker).toHaveLength(1);
    expect(forWorker[0].title).toBe("A");
    expect(forWorker[0].status).toBe("pending");
  });

  test("update appends a note and can change status", async () => {
    const t = await store.create({ title: "A", createdBy: "lead", assignee: "worker" });
    const updated = await store.update(t.id, "worker", { status: "in_progress", note: "started" });
    expect(updated?.status).toBe("in_progress");
    expect(updated?.notes).toHaveLength(1);
    expect(updated?.notes[0]).toMatchObject({ agent: "worker", text: "started" });
  });

  test("submitForReview blocks when checklist items are unchecked", async () => {
    const t = await store.create({
      title: "A", createdBy: "lead", assignee: "worker",
      checklist: ["run tests", "update docs"]
    });
    await expect(store.submitForReview(t.id, "worker", "done")).rejects.toThrow(/unchecked/);
  });

  test("submitForReview succeeds once all checklist items are checked", async () => {
    const t = await store.create({
      title: "A", createdBy: "lead", assignee: "worker",
      checklist: ["run tests", "update docs"]
    });
    await store.setChecklistItem(t.id, 0, true);
    await store.setChecklistItem(t.id, 1, true);
    const reviewed = await store.submitForReview(t.id, "worker", "all done");
    expect(reviewed.status).toBe("review");
    expect(reviewed.notes.at(-1)?.text).toContain("all done");
  });

  test("close(approved=true) marks done; close(approved=false) bounces to in_progress", async () => {
    const t = await store.create({ title: "A", createdBy: "lead", assignee: "worker" });
    await store.update(t.id, "worker", { status: "review" });

    const rejected = await store.close(t.id, "lead", false, "missing edge case");
    expect(rejected.status).toBe("in_progress");
    expect(rejected.notes.at(-1)?.text).toContain("missing edge case");

    await store.update(t.id, "worker", { status: "review" });
    const approved = await store.close(t.id, "lead", true);
    expect(approved.status).toBe("done");
  });

  test("activeOnly excludes done and cancelled tasks", async () => {
    const t1 = await store.create({ title: "A", createdBy: "lead", assignee: "worker" });
    const t2 = await store.create({ title: "B", createdBy: "lead", assignee: "worker" });
    await store.update(t2.id, "lead", { status: "cancelled" });
    const active = await store.list({ assignee: "worker", activeOnly: true });
    expect(active.map((t) => t.id)).toEqual([t1.id]);
  });

  test("rejects a path-escaping id", async () => {
    await expect(store.get("../evil")).resolves.toBeNull();
    await expect(store.update("../evil", "a", { note: "x" })).rejects.toThrow(/Invalid task id/);
  });
});
