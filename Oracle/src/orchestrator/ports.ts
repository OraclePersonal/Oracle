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

  /**
   * Release any underlying resources (e.g. an open MCP HTTP/SSE transport).
   * File-backed adapters have nothing to close and may omit this. Callers
   * should invoke it in a `finally` after a command finishes: on Windows a
   * still-open MCP streamable-http handle makes process teardown abort with a
   * libuv "UV_HANDLE_CLOSING" assertion instead of exiting cleanly.
   */
  close?(): Promise<void>;
}

export type ServiceType = "memory" | "messages";

export interface ProcessStatus {
  transport: "mcp" | "fallback";
  endpoint?: string;
  pid?: number;
  port?: number;
  reason?: string; // for fallback: why MCP failed
}
