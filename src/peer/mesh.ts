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
   * Acquire an exclusive lock on `resource` (typically a file path) for
   * `agent`. Uses `wx` (write, fail if exists) so two agents racing to
   * acquire the same lock can't both succeed — the filesystem itself
   * arbitrates, not a read-then-write check that has a race window. A lock
   * older than `ttlMs` is treated as abandoned (a crashed agent) and can be
   * stolen by the next caller.
   */
  async acquireLock(resource: string, agent: string, ttlMs = 5 * 60_000): Promise<LockAcquireResult> {
    await fs.mkdir(this.locksDir(), { recursive: true });
    const filePath = this.lockFilePath(resource);
    const record: LockRecord = { resource, agent, acquiredAt: new Date().toISOString(), ttlMs };

    try {
      await fs.writeFile(filePath, JSON.stringify(record, null, 2), { encoding: "utf8", flag: "wx" });
      return { acquired: true, lock: record };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    // Lock file exists — check whether it's expired (an abandoned lock)
    // before giving up. Re-attempt the exclusive create after removing it so
    // a second racer that also sees it as expired still can't both succeed.
    const existing = await this.readLockFile(filePath);
    if (existing && !this.isExpired(existing)) {
      return { acquired: false, lock: existing };
    }
    try {
      await fs.unlink(filePath);
      await fs.writeFile(filePath, JSON.stringify(record, null, 2), { encoding: "utf8", flag: "wx" });
      return { acquired: true, lock: record };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const current = await this.readLockFile(filePath);
        return { acquired: false, lock: current ?? undefined };
      }
      throw error;
    }
  }

  /** Release a lock — only the agent holding it can release it. */
  async releaseLock(resource: string, agent: string): Promise<boolean> {
    const filePath = this.lockFilePath(resource);
    const existing = await this.readLockFile(filePath);
    if (!existing) return false;
    if (existing.agent !== agent) return false;
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
}

export interface LockAcquireResult {
  acquired: boolean;
  lock?: LockRecord;
}
