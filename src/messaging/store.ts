import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { withRetry } from "./retry.js";

/**
 * File-backed inter-agent message store. Oracle acts as the relay: every
 * agent (Claude Code session, opencode, another oracle-mcp client) talks to
 * its own stdio server process, but they all share this directory, so a
 * message written by one process is visible to inbox queries from any other.
 *
 * One JSON file per message, written atomically (tmp + rename) so concurrent
 * readers never see a partial file. Read state lives inside the message as a
 * `readBy` list, updated with the same atomic pattern.
 *
 * I/O operations are wrapped with exponential-backoff retry for transient
 * system errors. Messages for agents that disappear can be pruned to the
 * dead-letter directory via `prune()`.
 */

export interface AgentMessage {
  id: string;
  /** ISO timestamp of when the message was stored. */
  ts: string;
  from: string;
  /** Recipient agent name, or "*" for broadcast to everyone. */
  to: string;
  subject?: string;
  body: string;
  /** id of the message this replies to, for threading. */
  replyTo?: string;
  /** Task/workflow linkage used by the durable coordination outbox. */
  taskId?: string;
  workflowId?: string;
  coordinationEventId?: string;
  /** Agent names that have acknowledged this message. */
  readBy: string[];
}

export interface SendInput {
  from: string;
  to: string;
  body: string;
  subject?: string;
  replyTo?: string;
  taskId?: string;
  workflowId?: string;
  coordinationEventId?: string;
}

function generateId(timestamp: string): string {
  const now = timestamp.replace(/[-:.TZ]/g, "").slice(0, 17);
  return `${now}-${crypto.randomBytes(4).toString("hex")}`;
}

export class MessageStore {
  private lastTimestampMs = 0;

  constructor(private readonly homeDir: string) {}

  private dir(): string {
    return path.join(this.homeDir, "messages");
  }

  private filePath(id: string): string {
    // ids are generated internally, but guard against path tricks anyway
    if (!/^[a-z0-9-]+$/i.test(id)) throw new Error(`Invalid message id: ${id}`);
    return path.join(this.dir(), `${id}.json`);
  }

  private async writeAtomic(filePath: string, msg: AgentMessage): Promise<void> {
    const tmp = `${filePath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await withRetry(() => fs.writeFile(tmp, JSON.stringify(msg, null, 2), "utf8"));
    await withRetry(() => fs.rename(tmp, filePath));
  }

  async send(input: SendInput): Promise<AgentMessage> {
    await fs.mkdir(this.dir(), { recursive: true });
    const deterministicId = input.coordinationEventId
      ? `coord-${crypto.createHash("sha256")
        .update(`${input.taskId ?? ""}:${input.coordinationEventId}`)
        .digest("hex")
        .slice(0, 24)}`
      : undefined;
    if (deterministicId) {
      const existing = await this.get(deterministicId);
      if (existing) return existing;
    }
    // Preserve call order even when several messages are created within the
    // same millisecond. This keeps inbox tail/limit behavior deterministic.
    const timestampMs = Math.max(Date.now(), this.lastTimestampMs + 1);
    this.lastTimestampMs = timestampMs;
    const timestamp = new Date(timestampMs).toISOString();
    const msg: AgentMessage = {
      id: deterministicId ?? generateId(timestamp),
      ts: timestamp,
      from: input.from,
      to: input.to,
      subject: input.subject,
      body: input.body,
      replyTo: input.replyTo,
      taskId: input.taskId,
      workflowId: input.workflowId,
      coordinationEventId: input.coordinationEventId,
      readBy: [],
    };
    await this.writeAtomic(this.filePath(msg.id), msg);
    return msg;
  }

  async get(id: string): Promise<AgentMessage | null> {
    const filePath = this.filePath(id); // validates id before any fs access
    try {
      const raw = await withRetry(() => fs.readFile(filePath, "utf8"));
      const msg = JSON.parse(raw) as AgentMessage;
      // Normalize shape: a hand-written or older-schema file missing readBy
      // must not poison every inbox call that touches it (verified live —
      // inbox() threw on m.readBy.includes and lost the whole inbox).
      if (!Array.isArray(msg.readBy)) msg.readBy = [];
      return msg;
    } catch {
      return null;
    }
  }

  private async readAll(): Promise<AgentMessage[]> {
    let entries: string[];
    try {
      entries = await withRetry(() => fs.readdir(this.dir()));
    } catch {
      return [];
    }
    const messages = await Promise.all(
      entries
        .filter((name) => name.endsWith(".json"))
        .map((name) => this.get(name.slice(0, -".json".length)))
    );
    return messages
      .filter((m): m is AgentMessage => m !== null)
      .sort((a, b) => a.ts.localeCompare(b.ts));
  }

  /**
   * Messages addressed to `agent` (directly or via broadcast), excluding the
   * agent's own sends. `unreadOnly` filters out already-acked messages.
   */
  async inbox(agent: string, opts?: { unreadOnly?: boolean; limit?: number }): Promise<AgentMessage[]> {
    const unreadOnly = opts?.unreadOnly ?? true;
    const limit = opts?.limit ?? 50;
    const all = await this.readAll();
    return all
      .filter((m) => (m.to === agent || m.to === "*") && m.from !== agent)
      .filter((m) => !unreadOnly || !m.readBy.includes(agent))
      .slice(-limit);
  }

  /** Mark messages as read by `agent`. Returns the ids actually updated. */
  async ack(agent: string, ids: string[]): Promise<string[]> {
    const acked: string[] = [];
    for (const id of ids) {
      const msg = await this.get(id);
      if (!msg || msg.readBy.includes(agent)) continue;
      msg.readBy.push(agent);
      await this.writeAtomic(this.filePath(id), msg);
      acked.push(id);
    }
    return acked;
  }

  /** Ack every currently-unread message for `agent`. Returns the acked ids. */
  async ackAll(agent: string): Promise<string[]> {
    const unread = await this.inbox(agent, { unreadOnly: true, limit: 1000 });
    return this.ack(agent, unread.map((m) => m.id));
  }

  /**
   * Time-first search across the WHOLE bus (any sender/recipient) — for
   * recalling what was discussed, e.g. "this morning's messages between
   * frontend and backend". `since`/`until` bound the window (ISO strings;
   * message `ts` is ISO so plain string compare is correct); `query` is an
   * optional case-insensitive substring filter over body+subject. Read-only:
   * never touches readBy — searching is recall, not receiving.
   */
  async search(opts: {
    since?: string;
    until?: string;
    query?: string;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<AgentMessage[]> {
    const limit = opts.limit ?? 20;
    const q = opts.query?.toLowerCase();
    const all = await this.readAll();
    return all
      .filter((m) => !opts.since || m.ts >= opts.since)
      .filter((m) => !opts.until || m.ts <= opts.until)
      .filter((m) => !opts.from || m.from === opts.from)
      .filter((m) => !opts.to || m.to === opts.to)
      .filter((m) => !q || m.body.toLowerCase().includes(q) || (m.subject ?? "").toLowerCase().includes(q))
      .slice(-limit)
      .reverse(); // newest first — recency matters when recalling
  }

  /** All messages linked to a task, oldest first. */
  async listForTask(taskId: string): Promise<AgentMessage[]> {
    return (await this.readAll()).filter((message) => message.taskId === taskId);
  }

  /** Full thread for a message: walk up to the root, then collect all replies below it. */
  async thread(id: string): Promise<AgentMessage[]> {
    const all = await this.readAll();
    const byId = new Map(all.map((m) => [m.id, m]));
    let root = byId.get(id);
    if (!root) return [];
    // Cycle guard: crafted replyTo cycles (a->b->a) must not hang the walk.
    const visited = new Set<string>([root.id]);
    while (root.replyTo && byId.get(root.replyTo) && !visited.has(root.replyTo)) {
      root = byId.get(root.replyTo)!;
      visited.add(root.id);
    }

    const result: AgentMessage[] = [];
    const queue = [root.id];
    const seen = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const msg = byId.get(current);
      if (msg) result.push(msg);
      for (const m of all) if (m.replyTo === current) queue.push(m.id);
    }
    return result.sort((a, b) => a.ts.localeCompare(b.ts));
  }

  // ─── Dead-letter queue ────────────────────────────────────────────

  private deadLetterDir(): string {
    return path.join(this.homeDir, "dead-letter");
  }

  /**
   * Move a message to the dead-letter directory. Idempotent — returns false
   * if the message does not exist or is already dead.
   */
  async deadLetter(id: string): Promise<boolean> {
    this.filePath(id); // validates id
    const src = this.filePath(id);
    await fs.mkdir(this.deadLetterDir(), { recursive: true });
    const dst = path.join(this.deadLetterDir(), `${id}.json`);
    try {
      await withRetry(() => fs.rename(src, dst));
      return true;
    } catch {
      return false; // already gone or concurrent move
    }
  }

  /**
   * Prune messages from the live bus:
   * - `orphanDays`: messages addressed to agents whose lastSeen is older than
   *   this threshold. Pass an agent registry list to check liveness, or pass
   *   `staleRecipients` directly for bulk dead-lettering.
   * - `maxAgeDays`: any message older than this is moved (regardless of read state).
   *
   * Returns the count of pruned messages.
   */
  async prune(opts: {
    staleRecipients?: string[];
    maxAgeDays?: number;
  }): Promise<number> {
    const all = await this.readAll();
    const now = Date.now();
    const staleRecipients = new Set(opts.staleRecipients ?? []);
    const maxAge = opts.maxAgeDays ? opts.maxAgeDays * 86400_000 : 0;

    let pruned = 0;
    for (const msg of all) {
      const tooOld = maxAge > 0 && now - new Date(msg.ts).getTime() > maxAge;
      const orphan = staleRecipients.size > 0 && staleRecipients.has(msg.to);
      if (tooOld || orphan) {
        if (await this.deadLetter(msg.id)) pruned++;
      }
    }
    return pruned;
  }

  /** Count and total size of dead-letter files. */
  async deadLetterStats(): Promise<{ count: number; sizeBytes: number }> {
    let entries: string[];
    try {
      entries = await withRetry(() => fs.readdir(this.deadLetterDir()));
    } catch {
      return { count: 0, sizeBytes: 0 };
    }
    const names = entries.filter((f) => f.endsWith(".json"));
    let sizeBytes = 0;
    for (const name of names) {
      try {
        const stat = await fs.stat(path.join(this.deadLetterDir(), name));
        sizeBytes += stat.size;
      } catch { /* best-effort */ }
    }
    return { count: names.length, sizeBytes };
  }

  /** Permanently delete dead-letter files older than `maxAgeDays`. */
  async purgeDeadLetter(maxAgeDays: number = 30): Promise<number> {
    let entries: string[];
    try {
      entries = await withRetry(() => fs.readdir(this.deadLetterDir()));
    } catch {
      return 0;
    }
    const cutoff = Date.now() - maxAgeDays * 86400_000;
    let removed = 0;
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      try {
        const stat = await fs.stat(path.join(this.deadLetterDir(), name));
        if (stat.mtimeMs < cutoff) {
          await fs.rm(path.join(this.deadLetterDir(), name));
          removed++;
        }
      } catch { /* best-effort */ }
    }
    return removed;
  }
}
