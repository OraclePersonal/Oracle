import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { MessagesPort } from "../orchestrator/ports.js";

// ponytail: writes directly to .oracle/messages/ format — compatible with oracle-messages bus.
// oracle-messages server reads the same files, so mesh is shared transparently.

export type MessageKind =
  | "message" | "note" | "question" | "review-request" | "review-result"
  | "proposal" | "proposal-response" | "wake" | "end" | "task"
  | "task-assign" | "task-update" | "task-complete" | "task-fail";

export interface MessageStoreEntry {
  id: string;
  sender: string;
  recipient: string;
  kind: MessageKind;
  body: string;
  subject?: string;
  parent_id?: string;
  in_reply_to?: string;
  channel?: string;
  meta?: Record<string, unknown>;
}

function generateId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const micros = String(now.getMilliseconds()).padStart(3, "0") + "000";
  const rand = crypto.randomBytes(4).toString("hex");
  return `${date}-${time}-${micros}-${rand}`;
}

export class MessagesAdapter implements MessagesPort {
  constructor(private readonly rootDir: string) {}

  private messagesDir(): string {
    return path.join(this.rootDir, ".oracle", "messages");
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.messagesDir(), { recursive: true });
  }

  async send(
    sender: string,
    recipient: string,
    body: string,
    kind: MessageKind = "message",
    opts?: { subject?: string; parentId?: string }
  ): Promise<MessageStoreEntry> {
    await this.ensureDir();
    const msg: MessageStoreEntry = {
      id: generateId(),
      sender,
      recipient,
      kind,
      body,
      subject: opts?.subject,
      parent_id: opts?.parentId,
    };
    const filePath = path.join(this.messagesDir(), `${msg.id}.json`);
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(msg, null, 2), "utf8");
    await fs.rename(tmp, filePath);
    return msg;
  }

  async broadcast(
    sender: string,
    body: string,
    kind: MessageKind = "note",
    opts?: { subject?: string }
  ): Promise<MessageStoreEntry> {
    return this.send(sender, "*", body, kind, opts);
  }

  async getMessages(
    filter?: { agent?: string; kind?: MessageKind; limit?: number }
  ): Promise<MessageStoreEntry[]> {
    const dir = this.messagesDir();
    try {
      // Filenames are timestamp-prefixed, so lexical sort == chronological order.
      // readdir() gives no ordering guarantee — sort before slicing or the most
      // recent messages can be silently dropped once the mailbox exceeds 100 files.
      const files = (await fs.readdir(dir)).sort();
      const messages: MessageStoreEntry[] = [];
      for (const file of files.slice(-100)) {
        if (!file.endsWith(".json")) continue;
        try {
          const msg = JSON.parse(await fs.readFile(path.join(dir, file), "utf8")) as MessageStoreEntry;
          if (filter?.agent && msg.recipient !== filter.agent && msg.recipient !== "*") continue;
          if (filter?.kind && msg.kind !== filter.kind) continue;
          messages.push(msg);
        } catch { /* skip corrupt */ }
      }
      const msgs = messages.sort((a, b) => a.id.localeCompare(b.id));
      return filter?.limit ? msgs.slice(-filter.limit) : msgs;
    } catch {
      return [];
    }
  }

  async getUnread(agent: string, sinceId?: string): Promise<MessageStoreEntry[]> {
    const all = await this.getMessages({ agent });
    if (!sinceId) return all.slice(-10);
    return all.filter((m) => m.id > sinceId);
  }

  async getThread(rootId: string): Promise<MessageStoreEntry[]> {
    const all = await this.getMessages();
    return all.filter((m) => m.id === rootId || m.parent_id === rootId || m.in_reply_to === rootId);
  }

  private locksDir(): string {
    return path.join(this.rootDir, ".oracle", "messages", "locks");
  }

  private lockFilePath(resource: string): string {
    const hash = crypto.createHash("sha1").update(resource).digest("hex");
    return path.join(this.locksDir(), `${hash}.json`);
  }

  /**
   * Acquire a short lease on `resource` (typically a file path) for `agent`.
   * Uses `wx` (write, fail if exists) so two agents racing to acquire the
   * same lock can't both succeed — the filesystem itself arbitrates, not a
   * read-then-write check that has a race window. A lease older than
   * `ttlMs` is treated as abandoned (a crashed agent) and can be stolen.
   *
   * Default TTL is deliberately short (60s, per a design review via
   * oracle_ask itself): a fixed multi-minute TTL forces a choice between
   * "too short for a slow task" and "too long to recover from a crash." The
   * short-lease + renewLock() pattern below decouples those — hold the lease
   * only for the critical section (read-latest → modify → write → release),
   * and renewLock() only if that section genuinely runs long, rather than
   * padding every lock with worst-case slack up front.
   *
   * Each successful acquire mints a new monotonically increasing `token`
   * (a fencing token) scoped to this resource, persisted across expiry/theft
   * via a small counter file so a token is never reused — a caller that was
   * paused past its lease and wakes up holding a stale token can be told "no
   * longer current" instead of silently overwriting whoever holds the lease
   * now (the classic distributed-lock split-brain hazard).
   */
  async acquireLock(resource: string, agent: string, ttlMs = 60_000): Promise<LockAcquireResult> {
    await fs.mkdir(this.locksDir(), { recursive: true });
    const filePath = this.lockFilePath(resource);

    const tryCreate = async (): Promise<LockAcquireResult> => {
      const token = await this.nextToken(resource);
      const record: LockRecord = { resource, agent, acquiredAt: new Date().toISOString(), ttlMs, token };
      await fs.writeFile(filePath, JSON.stringify(record, null, 2), { encoding: "utf8", flag: "wx" });
      return { acquired: true, lock: record };
    };

    try {
      return await tryCreate();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    // Lock file exists — check whether it's expired (an abandoned lease)
    // before giving up. Re-attempt the exclusive create after removing it so
    // a second racer that also sees it as expired still can't both succeed.
    const existing = await this.readLockFile(filePath);
    if (existing && !this.isExpired(existing)) {
      return { acquired: false, lock: existing };
    }
    try {
      await fs.unlink(filePath);
      return await tryCreate();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const current = await this.readLockFile(filePath);
        return { acquired: false, lock: current ?? undefined };
      }
      throw error;
    }
  }

  /**
   * Extend a lease you currently hold. Requires both `agent` and the
   * `token` returned by the acquire (or previous renew) call — an agent
   * that lost its lease to expiry-and-theft has a stale token that won't
   * match the new holder's, so it gets a clear "no longer current" instead
   * of silently reviving a lease someone else now owns.
   */
  async renewLock(resource: string, agent: string, token: number, ttlMs = 60_000): Promise<LockAcquireResult> {
    const filePath = this.lockFilePath(resource);
    const existing = await this.readLockFile(filePath);
    if (!existing || this.isExpired(existing) || existing.agent !== agent || existing.token !== token) {
      return { acquired: false, lock: existing && !this.isExpired(existing) ? existing : undefined };
    }
    const record: LockRecord = { resource, agent, acquiredAt: new Date().toISOString(), ttlMs, token };
    await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
    return { acquired: true, lock: record };
  }

  /**
   * Release a lock. `token` is optional for backward compatibility, but
   * when supplied it must match the current lease — same anti-split-brain
   * reasoning as renewLock().
   */
  async releaseLock(resource: string, agent: string, token?: number): Promise<boolean> {
    const filePath = this.lockFilePath(resource);
    const existing = await this.readLockFile(filePath);
    if (!existing) return false;
    if (existing.agent !== agent) return false;
    if (token !== undefined && existing.token !== token) return false;
    try {
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /** Check a lock's current state without acquiring it. Returns null if unlocked or expired. */
  async checkLock(resource: string): Promise<LockRecord | null> {
    const existing = await this.readLockFile(this.lockFilePath(resource));
    if (!existing || this.isExpired(existing)) return null;
    return existing;
  }

  /**
   * Monotonic per-resource counter for fencing tokens, persisted alongside
   * the lock so a token is never reused even across expiry/theft cycles —
   * a counter that reset per-acquire (e.g. always starting at 1) would let
   * a stale-but-not-yet-noticed old holder's token collide with a new
   * holder's after several theft cycles.
   */
  private async nextToken(resource: string): Promise<number> {
    const filePath = path.join(this.locksDir(), `${crypto.createHash("sha1").update(resource).digest("hex")}.token`);
    let current = 0;
    try {
      current = Number(await fs.readFile(filePath, "utf8")) || 0;
    } catch { /* first acquire for this resource */ }
    const next = current + 1;
    await fs.writeFile(filePath, String(next), "utf8");
    return next;
  }

  private isExpired(lock: LockRecord): boolean {
    return Date.now() - new Date(lock.acquiredAt).getTime() > lock.ttlMs;
  }

  private async readLockFile(filePath: string): Promise<LockRecord | null> {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8")) as LockRecord;
    } catch {
      return null;
    }
  }
}

export interface LockRecord {
  resource: string;
  agent: string;
  acquiredAt: string;
  ttlMs: number;
  /** Fencing token — increases monotonically per resource, never reused across expiry/theft cycles. */
  token: number;
}

export interface LockAcquireResult {
  acquired: boolean;
  lock?: LockRecord;
}
