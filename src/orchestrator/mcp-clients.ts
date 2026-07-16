import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { MemoryPort, MessagesPort } from "./ports.js";
import type { MemoryStoreEntry, MemoryType } from "../memory/adapter.js";
import type { MessageKind, MessageStoreEntry } from "../peer/mesh.js";
import { spawn } from "node:child_process";

/**
 * McpMemoryAdapter — placeholder implementation.
 * Full HTTP client integration deferred to next phase when MCP SDK API is clearer.
 * For now, falls back to file-based adapter in the factory.
 */
export class McpMemoryAdapter implements MemoryPort {
  constructor(endpoint: string) {
    // Placeholder: HTTP client to oracle-memory not yet implemented
    // Will use StdioClientTransport spawning oracle-memory binary
    throw new Error("McpMemoryAdapter not yet implemented — falling back to file adapter");
  }

  async remember(): Promise<MemoryStoreEntry> {
    throw new Error("Not implemented");
  }

  async recall(): Promise<MemoryStoreEntry[]> {
    throw new Error("Not implemented");
  }

  async forget(): Promise<void> {
    throw new Error("Not implemented");
  }

  async clearWorking(): Promise<number> {
    throw new Error("Not implemented");
  }
}

/**
 * McpMessagesAdapter — placeholder implementation.
 * Full HTTP client integration deferred to next phase when MCP SDK API is clearer.
 * For now, falls back to file-based adapter in the factory.
 */
export class McpMessagesAdapter implements MessagesPort {
  constructor(endpoint: string) {
    // Placeholder: HTTP client to oracle-messages not yet implemented
    throw new Error("McpMessagesAdapter not yet implemented — falling back to file adapter");
  }

  async send(): Promise<MessageStoreEntry> {
    throw new Error("Not implemented");
  }

  async broadcast(): Promise<MessageStoreEntry> {
    throw new Error("Not implemented");
  }

  async getMessages(): Promise<MessageStoreEntry[]> {
    throw new Error("Not implemented");
  }

  async getUnread(): Promise<MessageStoreEntry[]> {
    throw new Error("Not implemented");
  }

  async getThread(): Promise<MessageStoreEntry[]> {
    throw new Error("Not implemented");
  }
}
