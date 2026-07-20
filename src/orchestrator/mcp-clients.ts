import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { MemoryPort } from "./ports.js";
import type { MemoryStoreEntry, MemoryType } from "../memory/adapter.js";

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

  async recall(opts?: { type?: MemoryType; agent?: string; tags?: string[]; limit?: number; includeArchived?: boolean }): Promise<MemoryStoreEntry[]> {
    await this.ensureConnected();
    const result = (await this.client.callTool({
      name: "recall",
      arguments: {
        query: "*",
        type: opts?.type,
        agent: opts?.agent,
        tags: opts?.tags,
        limit: Math.min(opts?.limit ?? 20, 200),
        // the oracle-memory MCP server's equivalent knob is named includeExpired,
        // not includeArchived — same "don't hide superseded/archived entries" intent
        includeExpired: opts?.includeArchived,
      },
    })) as ToolResult;
    const text = this.extractText(result);
    const parsed = JSON.parse(text);
    if (!parsed.success) throw new Error(parsed.error || "recall failed");
    return (parsed.results || []) as MemoryStoreEntry[];
  }

  async searchMemories(query: string, opts?: { type?: MemoryType; agent?: string; limit?: number }): Promise<MemoryStoreEntry[]> {
    await this.ensureConnected();
    const result = (await this.client.callTool({
      name: "recall",
      arguments: {
        query,
        type: opts?.type,
        agent: opts?.agent,
        limit: Math.min(opts?.limit ?? 50, 200),
      },
    })) as ToolResult;
    const text = this.extractText(result);
    const parsed = JSON.parse(text);
    if (!parsed.success) throw new Error(parsed.error || "search failed");
    return (parsed.results || []) as MemoryStoreEntry[];
  }

  async updateMemory(id: string, type: MemoryType, updates: { content?: string; tags?: string[]; importance?: number }): Promise<MemoryStoreEntry | null> {
    await this.ensureConnected();
    try {
      const result = (await this.client.callTool({
        name: "remember",
        arguments: {
          entry_id: id,
          type,
          agent: "oracle",
          content: updates.content ?? "",
          tags: updates.tags,
          importance: updates.importance,
        },
      })) as ToolResult;
      const text = this.extractText(result);
      const parsed = JSON.parse(text);
      if (!parsed.success) return null;
      return parsed.memory as MemoryStoreEntry;
    } catch { return null; }
  }

  async getStats(): Promise<{ total: number; byType: Record<string, number>; byAgent: Record<string, number> }> {
    const all = await this.recall({ limit: 10_000 });
    const byType: Record<string, number> = {};
    const byAgent: Record<string, number> = {};
    for (const e of all) {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
      byAgent[e.agent] = (byAgent[e.agent] ?? 0) + 1;
    }
    return { total: all.length, byType, byAgent };
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
      name: "forget",
      arguments: { agent: agent ?? "" },
    })) as ToolResult;
    const text = this.extractText(result);
    const parsed = JSON.parse(text);
    if (!parsed.success) throw new Error(parsed.error || "clear_working failed");
    return parsed.cleared as number;
  }
}
