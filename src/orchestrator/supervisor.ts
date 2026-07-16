import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export interface ProcessInfo {
  pid: number;
  port: number;
  endpoint: string;
}

/**
 * ProcessSupervisor manages the lifecycle of oracle-memory and oracle-messages
 * as background daemon processes. Each process:
 * - Is spawned once and left running (not killed per CLI invocation)
 * - Exits via idle-timeout (10 min default, set via env var in the process)
 * - Stores pid/port in ~/.oracle/run/<service>.{pid,port} lockfiles
 * - Health-checked before trust via a lightweight ping call
 */
export class ProcessSupervisor {
  private readonly runDir: string;
  private activeProcesses = new Map<string, { process: ChildProcess; startTime: number }>();

  constructor(homeDir: string = path.join(os.homedir(), ".oracle")) {
    this.runDir = path.join(homeDir, "run");
  }

  /**
   * ensureRunning checks if a service process is already running (and healthy),
   * or spawns a new one if needed. Returns the endpoint (URL) or null if fallback is required.
   */
  async ensureRunning(
    service: "memory" | "messages"
  ): Promise<{ endpoint: string; pid: number; port: number } | null> {
    const existing = await this.readLockFile(service);

    if (existing) {
      // Health-check the existing process
      const isHealthy = await this.healthCheck(service, existing.endpoint);
      if (isHealthy) {
        return existing;
      }
      // Stale pid/port — clean it up and try to spawn new
      await this.removeLockFile(service);
    }

    // No existing process or it's dead — spawn new one
    return this.spawnService(service);
  }

  private async readLockFile(
    service: "memory" | "messages"
  ): Promise<{ endpoint: string; pid: number; port: number } | null> {
    try {
      const pidFile = path.join(this.runDir, `${service}.pid`);
      const portFile = path.join(this.runDir, `${service}.port`);

      const pid = parseInt(await fs.readFile(pidFile, "utf8"), 10);
      const port = parseInt(await fs.readFile(portFile, "utf8"), 10);

      if (!pid || !port || isNaN(pid) || isNaN(port)) return null;

      return {
        pid,
        port,
        endpoint: `http://127.0.0.1:${port}/mcp`,
      };
    } catch {
      return null;
    }
  }

  private async writeLockFile(service: "memory" | "messages", pid: number, port: number): Promise<void> {
    await fs.mkdir(this.runDir, { recursive: true });
    const pidFile = path.join(this.runDir, `${service}.pid`);
    const portFile = path.join(this.runDir, `${service}.port`);

    // Write atomically via temp file
    const pidTmp = `${pidFile}.tmp`;
    const portTmp = `${portFile}.tmp`;
    await fs.writeFile(pidTmp, String(pid), "utf8");
    await fs.rename(pidTmp, pidFile);
    await fs.writeFile(portTmp, String(port), "utf8");
    await fs.rename(portTmp, portFile);
  }

  private async removeLockFile(service: "memory" | "messages"): Promise<void> {
    try {
      await fs.unlink(path.join(this.runDir, `${service}.pid`));
    } catch {
      /* ignore */
    }
    try {
      await fs.unlink(path.join(this.runDir, `${service}.port`));
    } catch {
      /* ignore */
    }
  }

  private async healthCheck(service: "memory" | "messages", endpoint: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), 3000);

      const url =
        service === "memory"
          ? `${endpoint.replace("/mcp", "")}/health`
          : `${endpoint.replace("/mcp", "")}/ping`;

      const resp = await fetch(url, {
        method: "GET",
        signal: controller.signal as AbortSignal,
      });

      clearTimeout(timeoutHandle);
      return resp.ok;
    } catch {
      return false;
    }
  }

  private async findFreePort(): Promise<number> {
    // Simple heuristic: start from 9000, try until we find an open port
    // In production, could use a library like `get-port`
    for (let port = 9000; port < 10000; port++) {
      if (!(await this.isPortInUse(port))) {
        return port;
      }
    }
    throw new Error("No free ports available");
  }

  private async isPortInUse(port: number): Promise<boolean> {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      await fetch(`http://127.0.0.1:${port}/`, {
        method: "HEAD",
        signal: controller.signal as AbortSignal,
      });
      return true; // Port is in use if we got any response
    } catch {
      return false; // Port is free
    }
  }

  private async spawnService(service: "memory" | "messages"): Promise<{ endpoint: string; pid: number; port: number } | null> {
    const port = await this.findFreePort();
    const command = service === "memory" ? "oracle-memory" : "oracle-messages-mcp";

    try {
      // Spawn detached process
      const proc = spawn(command, ["--transport", "http", "--port", String(port)], {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          ...(service === "memory" && { ORACLE_MEMORY_PORT: String(port), ORACLE_MEMORY_TRANSPORT: "http" }),
          ...(service === "messages" && { ORACLE_PORT: String(port), ORACLE_TRANSPORT: "http" }),
        },
      });

      const pid = proc.pid;
      if (!pid) throw new Error("Failed to get process ID");

      // Unref so parent doesn't wait for this process
      proc.unref();
      this.activeProcesses.set(service, { process: proc, startTime: Date.now() });

      // Wait for health check to pass (with retry)
      const endpoint = `http://127.0.0.1:${port}/mcp`;
      let retries = 10;
      while (retries > 0) {
        await sleep(200);
        if (await this.healthCheck(service, endpoint)) {
          await this.writeLockFile(service, pid, port);
          return { endpoint, pid, port };
        }
        retries--;
      }

      // Health check never passed
      return null;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`Failed to spawn ${service}: ${reason}`);
      return null;
    }
  }

  /**
   * Gracefully shutdown a managed process (if we spawned it).
   * In practice, this is rarely needed since the daemon self-exits on idle timeout.
   */
  async shutdown(service: "memory" | "messages"): Promise<void> {
    const proc = this.activeProcesses.get(service);
    if (proc) {
      try {
        proc.process.kill("SIGTERM");
        await sleep(1000);
        if (!proc.process.killed) {
          proc.process.kill("SIGKILL");
        }
      } catch {
        /* ignore */
      }
      this.activeProcesses.delete(service);
    }
    await this.removeLockFile(service);
  }
}
