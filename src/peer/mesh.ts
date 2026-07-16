import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

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

export class MessagesAdapter {
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
      const files = await fs.readdir(dir);
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
}
