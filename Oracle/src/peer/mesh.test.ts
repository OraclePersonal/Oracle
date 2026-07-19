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
    await mesh.acquireLock("src/foo.ts", "agent-a", 30); // 30ms TTL
    await new Promise((r) => setTimeout(r, 150));
    const result = await mesh.acquireLock("src/foo.ts", "agent-b");
    expect(result.acquired).toBe(true);
    expect(result.lock?.agent).toBe("agent-b");
  });

  it("checkLock returns null for an expired lock", async () => {
    await mesh.acquireLock("src/foo.ts", "agent-a", 30);
    await new Promise((r) => setTimeout(r, 150));
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

  it("issues a fencing token that increases on each new acquisition of the same resource", async () => {
    const first = await mesh.acquireLock("src/foo.ts", "agent-a");
    expect(first.lock?.token).toBe(1);
    await mesh.releaseLock("src/foo.ts", "agent-a");
    const second = await mesh.acquireLock("src/foo.ts", "agent-b");
    expect(second.lock?.token).toBe(2);
  });

  it("renewLock extends the lease and keeps the same token for the current holder", async () => {
    const acquired = await mesh.acquireLock("src/foo.ts", "agent-a", 300);
    const token = acquired.lock!.token;
    await new Promise((r) => setTimeout(r, 150));
    const renewed = await mesh.renewLock("src/foo.ts", "agent-a", token, 300);
    expect(renewed.acquired).toBe(true);
    expect(renewed.lock?.token).toBe(token);
    // Still alive past the original 300ms window because it was renewed.
    await new Promise((r) => setTimeout(r, 200));
    expect(await mesh.checkLock("src/foo.ts")).not.toBeNull();
  });

  it("renewLock fails with a stale token after the lease was stolen", async () => {
    const acquired = await mesh.acquireLock("src/foo.ts", "agent-a", 50);
    const staleToken = acquired.lock!.token;
    await new Promise((r) => setTimeout(r, 150)); // lease expires
    await mesh.acquireLock("src/foo.ts", "agent-b"); // agent-b steals it, new token
    const renewResult = await mesh.renewLock("src/foo.ts", "agent-a", staleToken, 60_000);
    expect(renewResult.acquired).toBe(false);
  });

  it("renewLock fails for the wrong agent even with the right token", async () => {
    const acquired = await mesh.acquireLock("src/foo.ts", "agent-a");
    const token = acquired.lock!.token;
    const renewResult = await mesh.renewLock("src/foo.ts", "agent-b", token);
    expect(renewResult.acquired).toBe(false);
  });

  it("releaseLock with a mismatched token fails without releasing the lock", async () => {
    const acquired = await mesh.acquireLock("src/foo.ts", "agent-a");
    const wrongToken = acquired.lock!.token + 999;
    expect(await mesh.releaseLock("src/foo.ts", "agent-a", wrongToken)).toBe(false);
    expect(await mesh.checkLock("src/foo.ts")).not.toBeNull();
  });

  it("releaseLock with the correct token releases the lock", async () => {
    const acquired = await mesh.acquireLock("src/foo.ts", "agent-a");
    expect(await mesh.releaseLock("src/foo.ts", "agent-a", acquired.lock!.token)).toBe(true);
    expect(await mesh.checkLock("src/foo.ts")).toBeNull();
  });

  it("releaseLock omitting the token still works (backward compatible)", async () => {
    await mesh.acquireLock("src/foo.ts", "agent-a");
    expect(await mesh.releaseLock("src/foo.ts", "agent-a")).toBe(true);
  });
});
