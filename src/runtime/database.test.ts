import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RuntimeDatabase, SqliteCronTaskStore } from "./database.js";

let home: string;
let database: RuntimeDatabase;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-runtime-db-"));
  database = new RuntimeDatabase(home);
});

afterEach(async () => {
  database.close();
  await fs.rm(home, { recursive: true, force: true });
});

describe("RuntimeDatabase", () => {
  test("creates the SQLite file with owner-only permissions", async () => {
    const stat = await fs.stat(database.filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("persists scheduler tasks and run history in SQLite", async () => {
    const store = new SqliteCronTaskStore(database);
    const task = await store.create({
      name: "runtime test",
      cron: "*/5 * * * *",
      command: "echo ok"
    });
    await store.recordRun(task.id, "success", "ok");
    database.close();

    database = new RuntimeDatabase(home);
    const reloaded = await new SqliteCronTaskStore(database).get(task.id);
    expect(reloaded).toMatchObject({
      id: task.id,
      name: "runtime test",
      lastResult: "success",
      lastOutput: "ok"
    });

    const runs = database.connection.prepare(
      "SELECT task_id, result, output FROM scheduler_runs WHERE task_id = ?"
    ).all(task.id);
    expect(runs).toEqual([{ task_id: task.id, result: "success", output: "ok" }]);
  });

  test("imports legacy scheduler JSON idempotently", async () => {
    const legacyDir = path.join(home, "scheduler");
    await fs.mkdir(legacyDir, { recursive: true });
    const legacy = {
      id: "legacy-task-1",
      name: "legacy",
      cron: "0 2 * * *",
      command: "echo legacy",
      status: "active",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z"
    };
    await fs.writeFile(
      path.join(legacyDir, `${legacy.id}.json`),
      JSON.stringify(legacy),
      "utf8"
    );

    const store = new SqliteCronTaskStore(database);
    expect(await store.importLegacyDirectory(home)).toBe(1);
    expect(await store.importLegacyDirectory(home)).toBe(0);
    expect(await store.get(legacy.id)).toMatchObject({ name: "legacy" });
  });

  test("stores replayable runtime events in order", () => {
    const first = database.recordEvent("daemon.started", { pid: 123 });
    const second = database.recordEvent("scheduler.started", { activeTasks: 2 });

    expect(database.listEvents(first.id)).toEqual([second]);
    expect(database.listEvents(0).map((event) => event.type)).toEqual([
      "daemon.started",
      "scheduler.started"
    ]);
  });
});
