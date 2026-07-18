import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AckStatus, Acknowledgement, AgentRegistration, Cursor, MailboxStats, Message, MessageFilter, PresenceRecord, PresenceStatus, PruneResult, Reaction, SendInput, Subscription, Thread, Webhook } from "./types.js";

/**
 * JSONL file-backed message store.
 * Appends are atomic single-line writes; prune rewrites the full log.
 */
export class MessageStore {
  constructor(private readonly rootDir: string) {}

  // ─── Agent Registry ──────────────────────────────────────────

  async registerAgent(input: {
    agent: string;
    client?: string;
    role?: string;
    group?: string;
    capabilities?: string[];
    meta?: Record<string, unknown>;
  }): Promise<AgentRegistration> {
    const now = new Date().toISOString();
    const current = (await this.listAgents()).find((a) => a.agent === input.agent);
    const registration: AgentRegistration = {
      agent: input.agent,
      client: input.client ?? current?.client,
      role: input.role ?? current?.role,
      group: input.group ?? current?.group,
      capabilities: input.capabilities ?? current?.capabilities ?? [],
      registered_at: current?.registered_at ?? now,
      last_seen_at: now,
      meta: input.meta ?? current?.meta,
    };
    await this.append("agents.jsonl", registration);
    return registration;
  }

  async listAgents(): Promise<AgentRegistration[]> {
    const latest = new Map<string, AgentRegistration>();
    for (const entry of await this.readLog<AgentRegistration>("agents.jsonl"))
      latest.set(entry.agent, entry);
    return [...latest.values()].sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));
  }

  async retireAgent(agent: string): Promise<{ retired: boolean; cleaned: string[] }> {
    const all = new Map<string, AgentRegistration>();
    for (const entry of await this.readLog<AgentRegistration>("agents.jsonl"))
      all.set(entry.agent, entry);
    all.delete(agent);
    await this.writeLog("agents.jsonl", [...all.values()]);

    // Clean up associated data
    const cleaned: string[] = [];

    // Remove agent card
    const cards = await this.readLog<{ agent: string }>("cards.jsonl");
    const keptCards = cards.filter((c) => c.agent !== agent);
    if (keptCards.length !== cards.length) {
      await this.writeLog("cards.jsonl", keptCards);
      cleaned.push("card");
    }

    // Remove subscriptions
    const subs = await this.readLog<{ agent: string }>("subscriptions.jsonl");
    const keptSubs = subs.filter((s) => s.agent !== agent);
    if (keptSubs.length !== subs.length) {
      await this.writeLog("subscriptions.jsonl", keptSubs);
      cleaned.push("subscriptions");
    }

    // Remove cursors
    const cursors = await this.readLog<{ agent: string }>("cursors.jsonl");
    const keptCursors = cursors.filter((c) => c.agent !== agent);
    if (keptCursors.length !== cursors.length) {
      await this.writeLog("cursors.jsonl", keptCursors);
      cleaned.push("cursors");
    }

    return { retired: true, cleaned };
  }

  async setAgentRole(agent: string, role: string): Promise<AgentRegistration> {
    return this.registerAgent({ agent, role });
  }

  async setAgentGroup(agent: string, group: string): Promise<AgentRegistration> {
    return this.registerAgent({ agent, group });
  }

  // ─── Agent Cards ─────────────────────────────────────────────

  async setAgentCard(agent: string, card: {
    name?: string;
    description?: string;
    contact?: string;
    channels?: string[];
    meta?: Record<string, unknown>;
  }): Promise<void> {
    const entry = {
      agent,
      name: card.name,
      description: card.description,
      contact: card.contact,
      channels: card.channels ?? [],
      meta: card.meta,
      updated_at: new Date().toISOString(),
    };
    await this.append("cards.jsonl", entry);
  }

  async getAgentCard(agent: string): Promise<Record<string, unknown> | undefined> {
    const cards = await this.readLog<Record<string, unknown> & { agent: string }>("cards.jsonl");
    const latest = new Map<string, Record<string, unknown>>();
    for (const c of cards) latest.set(c.agent, c);
    const card = latest.get(agent);
    return card ? { ...card, channels: card.channels ?? [] } : undefined;
  }

  async findAgents(query: string): Promise<AgentRegistration[]> {
    const q = query.toLowerCase();
    return (await this.listAgents()).filter(
      (a) => a.agent.toLowerCase().includes(q)
        || (a.role && a.role.toLowerCase().includes(q))
        || (a.group && a.group.toLowerCase().includes(q))
        || a.capabilities.some((c) => c.toLowerCase().includes(q)),
    );
  }

  async getAgentInstructions(agent: string): Promise<string> {
    const agents = await this.listAgents();
    const found = agents.find((a) => a.agent === agent);
    if (!found) return "Agent not registered.";
    const lines: string[] = [`Agent: ${found.agent}`];
    if (found.client) lines.push(`Client: ${found.client}`);
    if (found.role) lines.push(`Role: ${found.role}`);
    if (found.group) lines.push(`Group: ${found.group}`);
    if (found.capabilities.length) lines.push(`Capabilities: ${found.capabilities.join(", ")}`);
    lines.push(`Registered: ${found.registered_at}`);
    lines.push(`Last seen: ${found.last_seen_at}`);
    return lines.join("\n");
  }

  // ─── Channels & Subscriptions ────────────────────────────────

  async subscribe(agent: string, channel: string): Promise<Subscription> {
    const subs = await this.readLog<Subscription>("subscriptions.jsonl");
    if (subs.some((s) => s.agent === agent && s.channel === channel))
      return subs.find((s) => s.agent === agent && s.channel === channel)!;
    const sub: Subscription = { agent, channel, subscribed_at: new Date().toISOString() };
    await this.append("subscriptions.jsonl", sub);
    return sub;
  }

  async unsubscribe(agent: string, channel: string): Promise<void> {
    const subs = await this.readLog<Subscription>("subscriptions.jsonl");
    const remaining = subs.filter((s) => !(s.agent === agent && s.channel === channel));
    await this.writeLog("subscriptions.jsonl", remaining);
  }

  async listSubscriptions(channel?: string): Promise<Subscription[]> {
    const subs = await this.readLog<Subscription>("subscriptions.jsonl");
    return channel ? subs.filter((s) => s.channel === channel) : subs;
  }

  // ─── Messaging ───────────────────────────────────────────────

  async send(input: SendInput): Promise<Message> {
    const message: Message = {
      id: `${Date.now()}-${crypto.randomUUID()}`,
      ts: new Date().toISOString(),
      sender: input.sender,
      recipient: input.recipient,
      kind: input.kind ?? "message",
      body: input.body,
      subject: input.subject,
      parent_id: input.parent_id,
      in_reply_to: input.in_reply_to,
      channel: input.channel,
      meta: input.meta,
    };
    if (input.ttl_seconds) {
      message.expires_at = new Date(Date.now() + input.ttl_seconds * 1000).toISOString();
    }
    await this.append("messages.jsonl", message);
    return message;
  }

  private isExpired(m: Message): boolean {
    return !!m.expires_at && new Date(m.expires_at) <= new Date();
  }

  async listMessages(filter: MessageFilter = {}): Promise<Message[]> {
    let messages = (await this.readLog<Message>("messages.jsonl")).filter((m) => !this.isExpired(m));
    if (filter.agent) {
      messages = messages.filter(
        (m) => m.sender === filter.agent || m.recipient === filter.agent || m.recipient === "*",
      );
    }
    if (filter.sender) messages = messages.filter((m) => m.sender === filter.sender);
    if (filter.kind) messages = messages.filter((m) => m.kind === filter.kind);
    if (filter.channel) messages = messages.filter((m) => m.channel === filter.channel);
    if (filter.query) {
      const q = filter.query.toLowerCase();
      messages = messages.filter(
        (m) => m.body.toLowerCase().includes(q)
          || (m.subject && m.subject.toLowerCase().includes(q)),
      );
    }
    return messages.slice(-(filter.limit ?? 100));
  }

  async readUnread(agent: string, limit = 50): Promise<Message[]> {
    const read = new Set(
      (await this.readLog<{ message_id: string; agent: string }>("reads.jsonl"))
        .filter((e) => e.agent === agent)
        .map((e) => e.message_id),
    );
    const messages = (await this.readLog<Message>("messages.jsonl"))
      .filter((m) => !this.isExpired(m))
      .filter(
        (m) => m.sender !== agent
          && (m.recipient === agent || m.recipient === "*")
          && !read.has(m.id),
      )
      .slice(-limit)
      .reverse();
    await Promise.all(
      messages.map((m) => this.append("reads.jsonl", { message_id: m.id, agent, ts: new Date().toISOString() })),
    );
    return messages;
  }

  async getMessage(id: string): Promise<Message | undefined> {
    const m = (await this.readLog<Message>("messages.jsonl")).find((m) => m.id === id);
    return m && !this.isExpired(m) ? m : undefined;
  }

  async getThread(rootId: string): Promise<{ root?: Message; replies: Message[] }> {
    const all = (await this.readLog<Message>("messages.jsonl")).filter((m) => !this.isExpired(m));
    const root = all.find((m) => m.id === rootId);
    const replies = all.filter(
      (m) => m.parent_id === rootId || m.in_reply_to === rootId,
    );
    return { root, replies };
  }

  async listOpenThreads(agent: string): Promise<Thread[]> {
    const messages = (await this.readLog<Message>("messages.jsonl")).filter((m) => !this.isExpired(m));
    const openers = messages.filter(
      (m) => (m.kind === "question" || m.kind === "review-request" || m.kind === "proposal")
        && m.recipient === agent,
    );
    const threads: Thread[] = [];
    for (const root of openers) {
      const replies = messages.filter(
        (m) => m.parent_id === root.id || m.in_reply_to === root.id,
      );
      threads.push({ root, replies });
    }
    return threads;
  }

  async searchMessages(query: string, limit = 50): Promise<Message[]> {
    const q = query.toLowerCase();
    return (await this.readLog<Message>("messages.jsonl"))
      .filter((m) => !this.isExpired(m))
      .filter((m) => m.body.toLowerCase().includes(q)
        || (m.subject && m.subject.toLowerCase().includes(q)))
      .slice(-limit);
  }

  async deleteMessage(id: string): Promise<boolean> {
    const all = await this.readLog<Message>("messages.jsonl");
    const idx = all.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    all.splice(idx, 1);
    await this.writeLog("messages.jsonl", all);
    return true;
  }

  // ─── Acknowledgements ────────────────────────────────────────

  async acknowledge(messageId: string, agent: string, status: AckStatus, note?: string): Promise<Acknowledgement> {
    if (!(await this.getMessage(messageId))) throw new Error(`Message not found: ${messageId}`);
    const ack: Acknowledgement = { message_id: messageId, agent, status, ts: new Date().toISOString(), note };
    await this.append("acknowledgements.jsonl", ack);
    return ack;
  }

  async getAcknowledgements(messageId: string): Promise<Acknowledgement[]> {
    return (await this.readLog<Acknowledgement>("acknowledgements.jsonl"))
      .filter((a) => a.message_id === messageId);
  }

  // ─── Cursors ─────────────────────────────────────────────────

  async advanceCursor(agent: string, messageId: string): Promise<Cursor> {
    const cursor: Cursor = { agent, message_id: messageId, ts: new Date().toISOString() };
    await this.append("cursors.jsonl", cursor);
    return cursor;
  }

  async getCursor(agent: string): Promise<Cursor | undefined> {
    const cursors = await this.readLog<Cursor>("cursors.jsonl");
    const latest = new Map<string, Cursor>();
    for (const c of cursors) latest.set(c.agent, c);
    return latest.get(agent);
  }

  // ─── Stats ───────────────────────────────────────────────────

  async mailboxStats(): Promise<MailboxStats> {
    const messages = await this.readLog<Message>("messages.jsonl");
    const agents = await this.listAgents();
    return {
      total_messages: messages.length,
      total_agents: agents.length,
      oldest_message_ts: messages.length > 0 ? messages[0].ts : null,
      newest_message_ts: messages.length > 0 ? messages[messages.length - 1].ts : null,
    };
  }

  // ─── Prune ───────────────────────────────────────────────────

  async prune(before: Date): Promise<PruneResult> {
    const beforeISO = before.toISOString();
    const all = await this.readLog<Message>("messages.jsonl");
    const kept = all.filter((m) => m.ts >= beforeISO && !this.isExpired(m));
    const removedIds = new Set(all.filter((m) => m.ts < beforeISO || this.isExpired(m)).map((m) => m.id));

    const reads = await this.readLog<{ message_id: string; agent: string; ts: string }>("reads.jsonl");
    const keptReads = reads.filter((r) => !removedIds.has(r.message_id) && r.ts >= beforeISO);
    const acks = await this.readLog<Acknowledgement>("acknowledgements.jsonl");
    const keptAcks = acks.filter((a) => !removedIds.has(a.message_id) && a.ts >= beforeISO);

    await Promise.all([
      this.writeLog("messages.jsonl", kept),
      this.writeLog("reads.jsonl", keptReads),
      this.writeLog("acknowledgements.jsonl", keptAcks),
    ]);

    return {
      messages_removed: all.length - kept.length,
      reads_removed: reads.length - keptReads.length,
      acknowledgements_removed: acks.length - keptAcks.length,
    };
  }

  // ─── Presence ────────────────────────────────────────────────

  async updatePresence(agent: string, status: PresenceStatus): Promise<PresenceRecord> {
    const record: PresenceRecord = {
      agent,
      status,
      since: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await this.append("presences.jsonl", record);
    return record;
  }

  async getPresence(agent: string): Promise<PresenceRecord | undefined> {
    const all = await this.readLog<PresenceRecord>("presences.jsonl");
    const latest = new Map<string, PresenceRecord>();
    for (const p of all) latest.set(p.agent, p);
    return latest.get(agent);
  }

  async listPresences(): Promise<PresenceRecord[]> {
    const all = await this.readLog<PresenceRecord>("presences.jsonl");
    const latest = new Map<string, PresenceRecord>();
    for (const p of all) latest.set(p.agent, p);
    return [...latest.values()];
  }

  // ─── Reactions ───────────────────────────────────────────────

  async react(messageId: string, agent: string, emoji: string): Promise<Reaction> {
    if (!(await this.getMessage(messageId))) throw new Error(`Message not found: ${messageId}`);
    const reaction: Reaction = { message_id: messageId, agent, emoji, ts: new Date().toISOString() };
    await this.append("reactions.jsonl", reaction);
    return reaction;
  }

  async listReactions(messageId: string): Promise<Reaction[]> {
    return (await this.readLog<Reaction>("reactions.jsonl"))
      .filter((r) => r.message_id === messageId);
  }

  // ─── Webhooks ────────────────────────────────────────────────

  async setWebhook(agent: string, url: string): Promise<Webhook> {
    // remove any existing webhook for this agent, then append new one
    const all = await this.readLog<Webhook>("webhooks.jsonl");
    const kept = all.filter((w) => w.agent !== agent);
    const wh: Webhook = { agent, url, created_at: new Date().toISOString() };
    kept.push(wh);
    await this.writeLog("webhooks.jsonl", kept);
    return wh;
  }

  async getWebhook(agent: string): Promise<Webhook | undefined> {
    return (await this.readLog<Webhook>("webhooks.jsonl")).find((w) => w.agent === agent);
  }

  async removeWebhook(agent: string): Promise<boolean> {
    const all = await this.readLog<Webhook>("webhooks.jsonl");
    const kept = all.filter((w) => w.agent !== agent);
    if (kept.length === all.length) return false;
    await this.writeLog("webhooks.jsonl", kept);
    return true;
  }

  // ─── Sessions (ephemeral, in-memory + file for rejoin) ───────

  async recordSession(agent: string): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.readLog<{ id: string; agent: string; joined_at: string; last_active_at: string }>("sessions.jsonl");
    const current = existing.filter((s) => s.agent !== agent);
    current.push({ id: crypto.randomUUID(), agent, joined_at: now, last_active_at: now });
    await this.writeLog("sessions.jsonl", current);
  }

  async getSessions(): Promise<{ id: string; agent: string; joined_at: string; last_active_at: string }[]> {
    return this.readLog("sessions.jsonl");
  }

  // ─── File I/O ────────────────────────────────────────────────

  private async append(file: string, value: unknown): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.appendFile(path.join(this.rootDir, file), `${JSON.stringify(value)}\n`, "utf8");
  }

  private async readLog<T>(file: string): Promise<T[]> {
    try {
      const data = await fs.readFile(path.join(this.rootDir, file), "utf8");
      const lines = data.split("\n").filter(Boolean);
      const result: T[] = [];
      for (const line of lines) {
        try { result.push(JSON.parse(line) as T); } catch { /* skip corrupted */ }
      }
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeLog<T>(file: string, entries: T[]): Promise<void> {
    const dest = path.join(this.rootDir, file);
    const tmp = dest + ".tmp";
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, dest);
  }
}
