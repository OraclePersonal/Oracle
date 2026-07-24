import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { RuntimeClient } from "./client.js";
import { OracleDaemon } from "./daemon.js";
import { readDaemonState } from "./state.js";

let home: string;
let daemon: OracleDaemon | undefined;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-daemon-"));
});

afterEach(async () => {
  await daemon?.stop();
  await fs.rm(home, { recursive: true, force: true });
});

describe("OracleDaemon", () => {
  test("serves scheduler API from SQLite and removes state on stop", async () => {
    daemon = new OracleDaemon({
      homeDir: home,
      host: "127.0.0.1",
      port: 0,
      token: "test-token"
    });
    const state = await daemon.start();
    const stateStat = await fs.stat(path.join(home, "runtime", "daemon.json"));
    expect(stateStat.mode & 0o777).toBe(0o600);
    const client = await RuntimeClient.connect(home);
    expect(client).not.toBeNull();
    const unauthorized = await fetch(`http://${state.host}:${state.port}/v1/schedules`);
    expect(unauthorized.status).toBe(401);
    expect(await client!.health()).toMatchObject({
      status: "ok",
      schedulerRunning: true,
      storage: "sqlite"
    });

    const task = await client!.createSchedule({
      name: "API task",
      cron: "*/5 * * * *",
      command: "node -e \"process.stdout.write('runtime-ok')\""
    });
    expect(await client!.listSchedules()).toHaveLength(1);
    expect((await client!.runSchedule(task.id)).output).toBe("runtime-ok");

    const failing = await client!.createSchedule({
      name: "failing API task",
      cron: "*/5 * * * *",
      command: "node -e \"process.exit(3)\""
    });
    expect(await client!.runSchedule(failing.id)).toMatchObject({ result: "error" });
    expect(await fs.stat(state.databasePath)).toBeDefined();

    await daemon.stop();
    expect(await readDaemonState(home)).toBeNull();
  });

  test("streams persisted scheduler events over WebSocket", async () => {
    daemon = new OracleDaemon({
      homeDir: home,
      host: "127.0.0.1",
      port: 0,
      token: "test-token"
    });
    await daemon.start();
    const client = (await RuntimeClient.connect(home))!;
    const socket = new WebSocket(client.webSocketUrl());
    const seen = new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as { type?: string; payload?: Record<string, unknown> };
        if (event.type === "scheduler.task.created") resolve(event.payload ?? {});
      });
      socket.on("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    const task = await client.createSchedule({
      name: "WebSocket task",
      cron: "*/10 * * * *",
      command: "echo websocket"
    });
    await expect(seen).resolves.toMatchObject({ task: { id: task.id } });
    socket.close();
  });

  test("rejects non-loopback API binding", async () => {
    daemon = new OracleDaemon({ homeDir: home, host: "0.0.0.0", port: 0 });
    await expect(daemon.start()).rejects.toThrow(/loopback/);
  });
});
