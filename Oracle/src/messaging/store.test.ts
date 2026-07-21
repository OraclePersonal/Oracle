import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MessageStore } from "./store.js";

let home: string;
let store: MessageStore;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-messages-"));
  store = new MessageStore(home);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("MessageStore", () => {
  test("send then inbox delivers to the recipient", async () => {
    await store.send({ from: "claude", to: "codex", body: "review src/a.ts please" });
    const inbox = await store.inbox("codex");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].from).toBe("claude");
    expect(inbox[0].body).toContain("review");
  });

  test("inbox excludes messages addressed to other agents", async () => {
    await store.send({ from: "claude", to: "codex", body: "for codex" });
    await store.send({ from: "claude", to: "gemini", body: "for gemini" });
    const inbox = await store.inbox("codex");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].body).toBe("for codex");
  });

  test("broadcast reaches everyone except the sender", async () => {
    await store.send({ from: "claude", to: "*", body: "build is green" });
    expect(await store.inbox("codex")).toHaveLength(1);
    expect(await store.inbox("gemini")).toHaveLength(1);
    expect(await store.inbox("claude")).toHaveLength(0);
  });

  test("ack marks read and unreadOnly inbox hides acked messages", async () => {
    const msg = await store.send({ from: "claude", to: "codex", body: "ping" });
    const acked = await store.ack("codex", [msg.id]);
    expect(acked).toEqual([msg.id]);
    expect(await store.inbox("codex")).toHaveLength(0);
    expect(await store.inbox("codex", { unreadOnly: false })).toHaveLength(1);
  });

  test("ack is per-agent for broadcasts", async () => {
    const msg = await store.send({ from: "claude", to: "*", body: "notice" });
    await store.ack("codex", [msg.id]);
    expect(await store.inbox("codex")).toHaveLength(0);
    expect(await store.inbox("gemini")).toHaveLength(1);
  });

  test("ack ignores unknown ids and double-acks", async () => {
    const msg = await store.send({ from: "a", to: "b", body: "x" });
    await store.ack("b", [msg.id]);
    const second = await store.ack("b", [msg.id, "nope-123"]);
    expect(second).toEqual([]);
  });

  test("thread collects root and replies in order", async () => {
    const root = await store.send({ from: "claude", to: "codex", body: "plan?" });
    const reply = await store.send({ from: "codex", to: "claude", body: "step 1", replyTo: root.id });
    await store.send({ from: "claude", to: "codex", body: "approved", replyTo: reply.id });

    const thread = await store.thread(reply.id);
    expect(thread).toHaveLength(3);
    expect(thread[0].body).toBe("plan?");
    expect(thread[2].body).toBe("approved");
  });

  test("inbox respects limit and returns newest tail", async () => {
    for (let i = 0; i < 5; i++) {
      await store.send({ from: "a", to: "b", body: `m${i}` });
    }
    const inbox = await store.inbox("b", { limit: 2 });
    expect(inbox).toHaveLength(2);
    expect(inbox[1].body).toBe("m4");
  });

  test("rejects a path-escaping id", async () => {
    await expect(store.ack("b", ["../evil"])).rejects.toThrow(/Invalid message id/);
  });
});
