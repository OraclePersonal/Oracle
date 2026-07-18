import path from "node:path";
import os from "node:os";
import { MemoryAdapter } from "../memory/adapter.js";
import { MessagesAdapter } from "../peer/mesh.js";
import { McpMemoryAdapter } from "./mcp-clients.js";
import { McpMessagesAdapter } from "./mcp-clients.js";
import { ProcessSupervisor } from "./supervisor.js";
import type { MemoryPort, MessagesPort, ProcessStatus } from "./ports.js";

/**
 * OrchestratorFactory manages the creation of memory and message adapters,
 * using ProcessSupervisor to determine whether to use MCP-backed or file-backed
 * implementations based on availability of running servers.
 */
export class OrchestratorFactory {
  private supervisor: ProcessSupervisor;
  private rootDir: string;
  private memoryStatus: Map<string, ProcessStatus> = new Map();
  private messagesStatus: Map<string, ProcessStatus> = new Map();

  constructor(rootDir: string, homeDir?: string) {
    this.rootDir = rootDir;
    this.supervisor = new ProcessSupervisor(homeDir ?? path.join(os.homedir(), ".oracle"));
  }

  /**
   * Create a memory adapter — tries MCP-backed first, falls back to file-based.
   */
  async createMemoryAdapter(): Promise<MemoryPort> {
    const sessionKey = `mem-${Date.now()}`; // Session-scoped status

    try {
      const info = await this.supervisor.ensureRunning("memory");
      if (info) {
        this.memoryStatus.set(sessionKey, {
          transport: "mcp",
          endpoint: info.endpoint,
          pid: info.pid,
          port: info.port,
        });
        console.debug(`[orchestrator] memory: MCP backend ready at ${info.endpoint}`);
        try {
          return new McpMemoryAdapter(info.endpoint);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.debug(`[orchestrator] memory MCP client init failed: ${reason} — falling back to file adapter`);
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.debug(`[orchestrator] memory MCP spawn failed: ${reason}`);
    }

    // Fallback to file-based
    this.memoryStatus.set(sessionKey, {
      transport: "fallback",
      reason: "MCP server unavailable",
    });
    console.debug(`[orchestrator] memory: falling back to file adapter`);
    return new MemoryAdapter(this.rootDir);
  }

  /**
   * Create a messages adapter — tries MCP-backed first, falls back to file-based.
   */
  async createMessagesAdapter(): Promise<MessagesPort> {
    const sessionKey = `msg-${Date.now()}`; // Session-scoped status

    try {
      const info = await this.supervisor.ensureRunning("messages");
      if (info) {
        this.messagesStatus.set(sessionKey, {
          transport: "mcp",
          endpoint: info.endpoint,
          pid: info.pid,
          port: info.port,
        });
        console.debug(`[orchestrator] messages: MCP backend ready at ${info.endpoint}`);
        try {
          return new McpMessagesAdapter(info.endpoint);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.debug(`[orchestrator] messages MCP client init failed: ${reason} — falling back to file adapter`);
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.debug(`[orchestrator] messages MCP spawn failed: ${reason}`);
    }

    // Fallback to file-based
    this.messagesStatus.set(sessionKey, {
      transport: "fallback",
      reason: "MCP server unavailable",
    });
    console.debug(`[orchestrator] messages: falling back to file adapter`);
    return new MessagesAdapter(this.rootDir);
  }

  /**
   * Get the current status (transport mode) for diagnostic/debugging.
   */
  getStatus(service: "memory" | "messages"): ProcessStatus | null {
    const statuses = service === "memory" ? this.memoryStatus : this.messagesStatus;
    // Return the most recent status
    const entries = Array.from(statuses.entries());
    return entries.length > 0 ? entries[entries.length - 1][1] : null;
  }
}
