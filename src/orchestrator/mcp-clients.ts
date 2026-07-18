import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { MemoryPort, MessagesPort } from "./ports.js";
import type { MemoryStoreEntry, MemoryType } from "../memory/adapter.js";
import type { MessageKind, MessageStoreEntry } from "../peer/mesh.js";

type ToolResult = { content: Array<{ type: string; text?: string }>; [key: string]: unknown };

/**
 * McpMemoryAdapter wraps the oracle-memory MCP server via HTTP StreamableHTTPClientTransport.
 */
export class McpMemoryAdapter implements MemoryPort {
  private client: Client;
  private url: URL;
  private connected = false;
  private connecting: Promise<void> | null = null;

  constructor(endpoint: string) {
    this.url = new URL(endpoint);
    this.client = new Client({ name: "oracle-cli", version: "0.1.0" }, { capabilities: {} });
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    // Concurrent calls (e.g. parallel remember/recall) must share one connect
    // attempt instead of racing multiple `client.connect()` calls on the same client.
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      try {
        const transport = new StreamableHTTPClientTransport(this.url);
        await this.client.connect(transport);
        this.connected = true;
      } catch (err) {
        throw new Error(`Failed to connect to oracle-memory at ${this.url}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  private extractText(result: ToolResult): string {
    const textContent = result.content.find((c) => c.type === "text");
    if (!textContent || !textContent.text) throw new Error("No text response from server");
    return textContent.text;
  }

  async remember(
    agent: string,
    type: MemoryType,
    content: string,
    opts?: { tags?: string[]; meta?: Record<string, unknown>; importance?: number }
  ): Promise<MemoryStoreEntry> {
    await this.ensureConnected();
    const result = (await this.client.callTool({
      name: "remember",
      arguments: {
        agent,
        type,
        content,
        tags: opts?.tags,
        importance: opts?.importance,
      },
    })) as ToolResult;

    const text = this.extractText(result);
    const parsed = JSON.parse(text);
    if (!parsed.success) throw new Error(parsed.error || "remember failed");
    return parsed.memory as MemoryStoreEntry;
  }

  async recall(type?: MemoryType, agent?: string, limit = 20): Promise<MemoryStoreEntry[]> {
    await this.ensureConnected();

    // oracle-memory's recall tool expects a query string
    const queryParts: string[] = [];
    if (agent) queryParts.push(`agent:${agent}`);
    if (type) queryParts.push(`type:${type}`);
    const query = queryParts.length > 0 ? queryParts.join(" ") : "*";

    const result = (await this.client.callTool({
      name: "recall",
      arguments: {
        query,
        limit: Math.min(limit, 200), // Respect server's max limit
      },
    })) as ToolResult;

    const text = this.extractText(result);
    const parsed = JSON.parse(text);
    if (!parsed.success) throw new Error(parsed.error || "recall failed");
    return (parsed.results || []) as MemoryStoreEntry[];
  }

  async forget(id: string, type: MemoryType): Promise<void> {
    await this.ensureConnected();
    const result = (await this.client.callTool({
      name: "forget",
      arguments: { id, type },
    })) as ToolResult;

    const text = this.extractText(result);
    const parsed = JSON.parse(text);
    if (!parsed.success) throw new Error(parsed.error || "forget failed");
  }

  async clearWorking(agent?: string): Promise<number> {
    await this.ensureConnected();
    const result = (await this.client.callTool({
      name: "clear_working",
      arguments: { ...(agent && { agent }) },
    })) as ToolResult;

    const text = this.extractText(result);
    const parsed = JSON.parse(text);
    if (!parsed.success) throw new Error(parsed.error || "clear_working failed");
    return parsed.count as number;
  }
}

/**
 * McpMessagesAdapter wraps the oracle-messages MCP server via HTTP StreamableHTTPClientTransport.
 */
export class McpMessagesAdapter implements MessagesPort {
  private client: Client;
  private url: URL;
  private connected = false;
  private connecting: Promise<void> | null = null;

  constructor(endpoint: string) {
    this.url = new URL(endpoint);
    this.client = new Client({ name: "oracle-cli", version: "0.1.0" }, { capabilities: {} });
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      try {
        const transport = new StreamableHTTPClientTransport(this.url);
        await this.client.connect(transport);
        this.connected = true;
      } catch (err) {
        throw new Error(`Failed to connect to oracle-messages at ${this.url}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  private extractText(result: ToolResult): string {
    const textContent = result.content.find((c) => c.type === "text");
    if (!textContent || !textContent.text) throw new Error("No text response from server");
    return textContent.text;
  }

  // The oracle-messages (Rust) tools return several different response shapes,
  // none of which is the `{ success, message(s) }` envelope this adapter used
  // to assume — so every messages call failed against the real server (the
  // integration tests only ever exercised the file adapter). The mappings
  // below follow the actual server contract in oracle-mcp/src/main.rs:
  //   send_message (single)  -> { success, message_id, sender, recipient, kind, ... }
  //   broadcast              -> { success, broadcast, results: [{ message_id, recipient }] }
  //   sync_messages          -> a BARE JSON array of Message objects (no envelope)
  //   get_thread             -> { success, thread: { root, replies } }
  // A serialized Message is { id, ts, sender, recipient, kind, subject, body,
  // parent_id, in_reply_to, channel, meta }.

  private mapMessage(raw: Record<string, unknown>): MessageStoreEntry {
    return {
      id: String((raw.id ?? raw.message_id ?? "") as string),
      sender: String((raw.sender ?? "") as string),
      recipient: String((raw.recipient ?? "") as string),
      kind: (raw.kind ?? "message") as MessageKind,
      body: String((raw.body ?? "") as string),
      subject: raw.subject ? String(raw.subject as string) : undefined,
      parent_id: (raw.parent_id as string) ?? undefined,
      in_reply_to: (raw.in_reply_to as string) ?? undefined,
      channel: (raw.channel as string) ?? undefined,
      meta: (raw.meta as Record<string, unknown>) ?? undefined,
    };
  }

  async send(
    sender: string,
    recipient: string,
    body: string,
    kind: MessageKind = "message",
    opts?: { subject?: string; parentId?: string }
  ): Promise<MessageStoreEntry> {
    await this.ensureConnected();
    const result = (await this.client.callTool({
      name: "send_message",
      arguments: {
        recipient,
        body,
        sender,
        kind,
        subject: opts?.subject,
        parent_id: opts?.parentId,
      },
    })) as ToolResult;

    const parsed = JSON.parse(this.extractText(result));
    if (parsed.success === false) throw new Error(parsed.error || "send_message failed");
    // The single-recipient response echoes ids/routing but not body/subject,
    // so fill those from the request to return a complete entry.
    return {
      id: String(parsed.message_id ?? ""),
      sender: String(parsed.sender ?? sender),
      recipient: String(parsed.recipient ?? recipient),
      kind: (parsed.kind ?? kind) as MessageKind,
      body,
      subject: opts?.subject,
      parent_id: opts?.parentId,
    };
  }

  async broadcast(
    sender: string,
    body: string,
    kind: MessageKind = "note",
    opts?: { subject?: string }
  ): Promise<MessageStoreEntry> {
    await this.ensureConnected();
    const result = (await this.client.callTool({
      name: "broadcast",
      arguments: {
        sender,
        body,
        kind,
        subject: opts?.subject,
      },
    })) as ToolResult;

    const parsed = JSON.parse(this.extractText(result));
    if (parsed.success === false) throw new Error(parsed.error || "broadcast failed");
    // broadcast fans out to N recipients; the port returns a single entry, so
    // synthesize one representing the "*" send (id taken from the first fanned
    // delivery, if any).
    const results = Array.isArray(parsed.results) ? (parsed.results as Array<Record<string, unknown>>) : [];
    const firstId = results.find((r) => r.message_id)?.message_id;
    return {
      id: String(firstId ?? ""),
      sender,
      recipient: "*",
      kind,
      body,
      subject: opts?.subject,
    };
  }

  async getMessages(filter?: {
    agent?: string;
    kind?: MessageKind;
    limit?: number;
  }): Promise<MessageStoreEntry[]> {
    await this.ensureConnected();
    const result = (await this.client.callTool({
      name: "sync_messages",
      arguments: {
        agent: filter?.agent,
        limit: Math.min(filter?.limit ?? 100, 200),
      },
    })) as ToolResult;

    const messages = this.parseMessageArray(this.extractText(result));
    // sync_messages has no server-side kind filter, so apply it here.
    return filter?.kind ? messages.filter((m) => m.kind === filter.kind) : messages;
  }

  async getUnread(agent: string, _sinceId?: string): Promise<MessageStoreEntry[]> {
    await this.ensureConnected();
    // The server tracks each agent's read cursor and auto-advances it, so there
    // is no `since` parameter — unread is resolved from stored cursor state.
    const result = (await this.client.callTool({
      name: "sync_messages",
      arguments: {
        agent,
        limit: 50,
      },
    })) as ToolResult;

    return this.parseMessageArray(this.extractText(result));
  }

  private parseMessageArray(text: string): MessageStoreEntry[] {
    const parsed = JSON.parse(text);
    // Normally a bare array; tolerate an { error } object or { messages } shape.
    if (Array.isArray(parsed)) return parsed.map((m) => this.mapMessage(m));
    if (parsed && parsed.success === false) throw new Error(parsed.error || "sync_messages failed");
    if (Array.isArray(parsed?.messages)) return parsed.messages.map((m: Record<string, unknown>) => this.mapMessage(m));
    return [];
  }

  async getThread(rootId: string): Promise<MessageStoreEntry[]> {
    await this.ensureConnected();
    const result = (await this.client.callTool({
      name: "get_thread",
      arguments: { root_id: rootId },
    })) as ToolResult;

    const parsed = JSON.parse(this.extractText(result));
    if (parsed.success === false) throw new Error(parsed.error || "get_thread failed");
    const thread = (parsed.thread ?? {}) as { root?: Record<string, unknown>; replies?: Array<Record<string, unknown>> };
    const messages: MessageStoreEntry[] = [];
    if (thread.root) messages.push(this.mapMessage(thread.root));
    if (Array.isArray(thread.replies)) messages.push(...thread.replies.map((r) => this.mapMessage(r)));
    return messages;
  }

  /**
   * Close the MCP client and its streamable-http transport. Without this the
   * open SSE handle keeps a libuv async handle alive, and process teardown on
   * Windows aborts with a "UV_HANDLE_CLOSING" assertion. Best-effort: a close
   * failure must never mask the command's own result/error.
   */
  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    try {
      await this.client.close();
    } catch {
      /* ignore — already gone or never fully connected */
    }
  }
}
