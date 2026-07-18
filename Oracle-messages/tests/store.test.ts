import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MessageStore } from "../src/store.js";

const roots: string[] = [];

async function createStore(): Promise<MessageStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-messages-"));
  roots.push(root);
  return new MessageStore(root);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("MessageStore", () => {
  test("delivers direct and broadcast messages once per recipient", async () => {
    const store = await createStore();
    const direct = await store.send({ sender: "claude", recipient: "gemini", body: "Review this" });
    const broadcast = await store.send({ sender: "clew", recipient: "*", body: "Build passed", kind: "event" });

    expect((await store.readUnread("gemini")).map((message) => message.id)).toEqual([broadcast.id, direct.id]);
    expect(await store.readUnread("gemini")).toEqual([]);
    expect((await store.readUnread("opencode")).map((message) => message.id)).toEqual([broadcast.id]);
    expect(await store.readUnread("clew")).toEqual([]);
  });

  test("preserves threads and processing acknowledgements", async () => {
    const store = await createStore();
    const root = await store.send({ sender: "cline", recipient: "kilo", body: "Fix test", kind: "request" });
    const reply = await store.send({
      sender: "kilo",
      recipient: "cline",
      body: "Fixed",
      kind: "response",
      parent_id: root.id,
      in_reply_to: root.id,
    });
    await store.acknowledge(root.id, "kilo", "completed", "Tests pass");

    expect(await store.getThread(root.id)).toEqual({ root, replies: [reply] });
    expect(await store.getAcknowledgements(root.id)).toMatchObject([
      { message_id: root.id, agent: "kilo", status: "completed", note: "Tests pass" },
    ]);
  });

  test("keeps the latest registration for each stable agent name", async () => {
    const store = await createStore();
    await store.registerAgent({ agent: "claude", client: "Claude Code", capabilities: ["review"] });
    await store.registerAgent({ agent: "claude", capabilities: ["review", "test"] });

    expect(await store.listAgents()).toMatchObject([
      { agent: "claude", client: "Claude Code", capabilities: ["review", "test"] },
    ]);
  });

  test("mailbox_stats returns counts and bounds", async () => {
    const store = await createStore();
    expect(await store.mailboxStats()).toMatchObject({ total_messages: 0, total_agents: 0 });

    await store.registerAgent({ agent: "a", capabilities: [] });
    await store.registerAgent({ agent: "b", capabilities: [] });
    await store.send({ sender: "a", recipient: "b", body: "hello" });
    await store.send({ sender: "b", recipient: "a", body: "hi" });

    const stats = await store.mailboxStats();
    expect(stats.total_messages).toBe(2);
    expect(stats.total_agents).toBe(2);
    expect(stats.oldest_message_ts).toBeTruthy();
    expect(stats.newest_message_ts).toBeTruthy();
  });

  test("prune removes old messages and keeps recent ones", async () => {
    const store = await createStore();
    const old = await store.send({ sender: "a", recipient: "b", body: "old" });
    /* tiny delay so timestamps differ */
    await new Promise((r) => setTimeout(r, 5));
    const recent = await store.send({ sender: "a", recipient: "b", body: "recent" });

    // Prune anything before "recent" (roughly now)
    await store.prune(new Date(recent.ts));

    const remaining = await store.listMessages();
    expect(remaining.map((m) => m.id)).toEqual([recent.id]);
    expect(await store.getMessage(old.id)).toBeUndefined();
  });
});
