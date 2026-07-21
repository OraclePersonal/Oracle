import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * File-backed inter-agent message store. Oracle acts as the relay: every
 * agent (Claude Code session, opencode, another oracle-mcp client) talks to
 * its own stdio server process, but they all share this directory, so a
 * message written by one process is visible to inbox queries from any other.
 *
 * One JSON file per message, written atomically (tmp + rename) so concurrent
 * readers never see a partial file. Read state lives inside the message as a
 * `readBy` list, updated with the same atomic pattern.
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
  /** Agent names that have acknowledged this message. */
  readBy: string[];
}

export interface SendInput {
  from: string;
  to: string;
  body: string;
  subject?: string;
  replyTo?: string;
}

function generateId(): string {
  const now = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
  return `${now}-${crypto.randomBytes(4).toString("hex")}`;
}

export class MessageStore {
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
    await fs.writeFile(tmp, JSON.stringify(msg, null, 2), "utf8");
    await fs.rename(tmp, filePath);
  }

  async send(input: SendInput): Promise<AgentMessage> {
    await fs.mkdir(this.dir(), { recursive: true });
    const msg: AgentMessage = {
      id: generateId(),
      ts: new Date().toISOString(),
      from: input.from,
      to: input.to,
      subject: input.subject,
      body: input.body,
      replyTo: input.replyTo,
      readBy: [],
    };
    await this.writeAtomic(this.filePath(msg.id), msg);
    return msg;
  }

  async get(id: string): Promise<AgentMessage | null> {
    const filePath = this.filePath(id); // validates id before any fs access
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8")) as AgentMessage;
    } catch {
      return null;
    }
  }

  private async readAll(): Promise<AgentMessage[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir());
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

  /** Full thread for a message: walk up to the root, then collect all replies below it. */
  async thread(id: string): Promise<AgentMessage[]> {
    const all = await this.readAll();
    const byId = new Map(all.map((m) => [m.id, m]));
    let root = byId.get(id);
    if (!root) return [];
    while (root.replyTo && byId.get(root.replyTo)) root = byId.get(root.replyTo)!;

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
}
