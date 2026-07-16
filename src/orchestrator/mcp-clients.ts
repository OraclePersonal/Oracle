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

  constructor(endpoint: string) {
    this.url = new URL(endpoint);
    this.client = new Client({ name: "oracle-cli", version: "0.1.0" }, { capabilities: {} });
  }

  private async ensureConnected(): Promise<void> {
    // Check if already connected
    if ((this.client as any)._transport) return;

    try {
      const transport = new StreamableHTTPClientTransport(this.url);
      await this.client.connect(transport);
    } catch (err) {
      throw new Error(`Failed to connect to oracle-memory at ${this.url}: ${err instanceof Error ? err.message : String(err)}`);
    }
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

  constructor(endpoint: string) {
    this.url = new URL(endpoint);
    this.client = new Client({ name: "oracle-cli", version: "0.1.0" }, { capabilities: {} });
  }

  private async ensureConnected(): Promise<void> {
    // Check if already connected
    if ((this.client as any)._transport) return;

    try {
      const transport = new StreamableHTTPClientTransport(this.url);
      await this.client.connect(transport);
    } catch (err) {
      throw new Error(`Failed to connect to oracle-messages at ${this.url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private extractText(result: ToolResult): string {
    const textContent = result.content.find((c) => c.type === "text");
    if (!textContent || !textContent.text) throw new Error("No text response from server");
    return textContent.text;
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
        to: recipient,
        body,
        kind,
        subject: opts?.subject,
        in_reply_to: opts?.parentId,
      },
    })) as ToolResult;

    const text = this.extractText(result);
    const parsed = JSON.parse(text);
    if (!parsed.success) throw new Error(parsed.error || "send_message failed");
    return parsed.message as MessageStoreEntry;
  }

  async broadcast(
    _sender: string,
    body: string,
    kind: MessageKind = "note",
    opts?: { subject?: string }
  ): Promise<MessageStoreEntry> {
    await this.ensureConnected();
    const result = (await this.client.callTool({
      name: "broadcast",
      arguments: {
        body,
        kind,
        subject: opts?.subject,
      },
    })) as ToolResult;

    const text = this.extractText(result);
    const parsed = JSON.parse(text);
    if (!parsed.success) throw new Error(parsed.error || "broadcast failed");
    return parsed.message as MessageStoreEntry;
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
        kind: filter?.kind,
        limit: Math.min(filter?.limit ?? 100, 200),
      },
    })) as ToolResult;

    const text = this.extractText(result);
    const parsed = JSON.parse(text);
    if (!parsed.success) throw new Error(parsed.error || "sync_messages failed");
    return (parsed.messages || []) as MessageStoreEntry[];
  }

  async getUnread(agent: string, sinceId?: string): Promise<MessageStoreEntry[]> {
    await this.ensureConnected();
    const result = (await this.client.callTool({
      name: "sync_messages",
      arguments: {
        agent,
        since: sinceId,
        limit: 50,
      },
    })) as ToolResult;

    const text = this.extractText(result);
    const parsed = JSON.parse(text);
    if (!parsed.success) throw new Error(parsed.error || "sync_messages failed");
    return (parsed.messages || []) as MessageStoreEntry[];
  }

  async getThread(rootId: string): Promise<MessageStoreEntry[]> {
    await this.ensureConnected();
    const result = (await this.client.callTool({
      name: "get_thread",
      arguments: { root_id: rootId },
    })) as ToolResult;

    const text = this.extractText(result);
    const parsed = JSON.parse(text);
    if (!parsed.success) throw new Error(parsed.error || "get_thread failed");
    return (parsed.messages || []) as MessageStoreEntry[];
  }
}
