import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MessagesAdapter } from "./mesh.js";

describe("MessagesAdapter locks", () => {
  let tmp: string;
  let mesh: MessagesAdapter;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-mesh-test-"));
    mesh = new MessagesAdapter(tmp);
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("acquires a lock on an unlocked resource", async () => {
    const result = await mesh.acquireLock("src/foo.ts", "agent-a");
    expect(result.acquired).toBe(true);
    expect(result.lock?.agent).toBe("agent-a");
  });

  it("refuses a second agent while the lock is held", async () => {
    await mesh.acquireLock("src/foo.ts", "agent-a");
    const second = await mesh.acquireLock("src/foo.ts", "agent-b");
    expect(second.acquired).toBe(false);
    expect(second.lock?.agent).toBe("agent-a");
  });

  it("checkLock reflects the current holder without acquiring", async () => {
    expect(await mesh.checkLock("src/foo.ts")).toBeNull();
    await mesh.acquireLock("src/foo.ts", "agent-a");
    const lock = await mesh.checkLock("src/foo.ts");
    expect(lock?.agent).toBe("agent-a");
  });

  it("only the holder can release the lock", async () => {
    await mesh.acquireLock("src/foo.ts", "agent-a");
    expect(await mesh.releaseLock("src/foo.ts", "agent-b")).toBe(false);
    expect(await mesh.checkLock("src/foo.ts")).not.toBeNull();
    expect(await mesh.releaseLock("src/foo.ts", "agent-a")).toBe(true);
    expect(await mesh.checkLock("src/foo.ts")).toBeNull();
  });

  it("releasing an unlocked resource returns false", async () => {
    expect(await mesh.releaseLock("src/never-locked.ts", "agent-a")).toBe(false);
  });

  it("lets a second agent acquire after release", async () => {
    await mesh.acquireLock("src/foo.ts", "agent-a");
    await mesh.releaseLock("src/foo.ts", "agent-a");
    const result = await mesh.acquireLock("src/foo.ts", "agent-b");
    expect(result.acquired).toBe(true);
  });

  it("treats an expired lock as abandoned and lets another agent steal it", async () => {
    await mesh.acquireLock("src/foo.ts", "agent-a", 10); // 10ms TTL
    await new Promise((r) => setTimeout(r, 30));
    const result = await mesh.acquireLock("src/foo.ts", "agent-b");
    expect(result.acquired).toBe(true);
    expect(result.lock?.agent).toBe("agent-b");
  });

  it("checkLock returns null for an expired lock", async () => {
    await mesh.acquireLock("src/foo.ts", "agent-a", 10);
    await new Promise((r) => setTimeout(r, 30));
    expect(await mesh.checkLock("src/foo.ts")).toBeNull();
  });

  it("only one of two concurrent acquires on the same resource succeeds", async () => {
    const [a, b] = await Promise.all([
      mesh.acquireLock("src/race.ts", "agent-a"),
      mesh.acquireLock("src/race.ts", "agent-b")
    ]);
    const acquiredCount = [a, b].filter((r) => r.acquired).length;
    expect(acquiredCount).toBe(1);
  });

  it("distinct resources don't contend with each other", async () => {
    const a = await mesh.acquireLock("src/a.ts", "agent-a");
    const b = await mesh.acquireLock("src/b.ts", "agent-b");
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
  });
});
