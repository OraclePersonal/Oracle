import type { MemoryStoreEntry, MemoryType } from "../memory/adapter.js";
import type { MessageKind, MessageStoreEntry, LockRecord, LockAcquireResult } from "../peer/mesh.js";

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

  recall(opts?: { type?: MemoryType; agent?: string; tags?: string[]; limit?: number; includeArchived?: boolean }): Promise<MemoryStoreEntry[]>;

  searchMemories(query: string, opts?: { type?: MemoryType; agent?: string; limit?: number }): Promise<MemoryStoreEntry[]>;

  updateMemory(id: string, type: MemoryType, updates: { content?: string; tags?: string[]; importance?: number }): Promise<MemoryStoreEntry | null>;

  getStats(): Promise<{ total: number; byType: Record<string, number>; byAgent: Record<string, number> }>;

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

  /**
   * Multi-agent coordination locks (e.g. "don't let two agents edit the same
   * file at once"). Optional: only the file-backed MessagesAdapter
   * implements these today — the MCP-backed oracle-messages bus has no
   * matching lock tools, so callers must check for presence before use
   * rather than assuming every MessagesPort supports locking.
   */
  acquireLock?(resource: string, agent: string, ttlMs?: number): Promise<LockAcquireResult>;
  renewLock?(resource: string, agent: string, token: number, ttlMs?: number): Promise<LockAcquireResult>;
  releaseLock?(resource: string, agent: string, token?: number): Promise<boolean>;
  checkLock?(resource: string): Promise<LockRecord | null>;
}

export type ServiceType = "memory" | "messages";

export interface ProcessStatus {
  transport: "mcp" | "fallback";
  endpoint?: string;
  pid?: number;
  port?: number;
  reason?: string; // for fallback: why MCP failed
}
