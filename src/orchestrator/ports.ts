import type { MemoryStoreEntry, MemoryType } from "../memory/adapter.js";

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

export type ServiceType = "memory";

export interface ProcessStatus {
  transport: "mcp" | "fallback";
  endpoint?: string;
  pid?: number;
  port?: number;
  reason?: string; // for fallback: why MCP failed
}
