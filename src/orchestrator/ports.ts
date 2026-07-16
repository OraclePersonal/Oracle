import type { MemoryStoreEntry, MemoryType } from "../memory/adapter.js";
import type { MessageKind, MessageStoreEntry } from "../peer/mesh.js";

/**
 * MemoryPort — abstraction over memory storage (file-based or MCP-backed).
 * Both FileAdapter and McpBackedAdapter implement this interface.
 */
export interface MemoryPort {
  remember(
    agent: string,
    type: MemoryType,
    content: string,
    opts?: { tags?: string[]; meta?: Record<string, unknown>; importance?: number }
  ): Promise<MemoryStoreEntry>;

  recall(type?: MemoryType, agent?: string, limit?: number): Promise<MemoryStoreEntry[]>;

  forget(id: string, type: MemoryType): Promise<void>;

  clearWorking(agent?: string): Promise<number>;
}

/**
 * MessagesPort — abstraction over message storage (file-based or MCP-backed).
 * Both FileAdapter and McpBackedAdapter implement this interface.
 */
export interface MessagesPort {
  send(
    sender: string,
    recipient: string,
    body: string,
    kind?: MessageKind,
    opts?: { subject?: string; parentId?: string }
  ): Promise<MessageStoreEntry>;

  broadcast(
    sender: string,
    body: string,
    kind?: MessageKind,
    opts?: { subject?: string }
  ): Promise<MessageStoreEntry>;

  getMessages(filter?: {
    agent?: string;
    kind?: MessageKind;
    limit?: number;
  }): Promise<MessageStoreEntry[]>;

  getUnread(agent: string, sinceId?: string): Promise<MessageStoreEntry[]>;

  getThread(rootId: string): Promise<MessageStoreEntry[]>;
}

export type ServiceType = "memory" | "messages";

export interface ProcessStatus {
  transport: "mcp" | "fallback";
  endpoint?: string;
  pid?: number;
  port?: number;
  reason?: string; // for fallback: why MCP failed
}
