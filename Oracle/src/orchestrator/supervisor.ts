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
 * ProcessSupervisor manages the lifecycle of oracle-memory as a background
 * daemon process. The process:
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
    service: "memory"
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

    // No existing process or it's dead — spawn new one, guarded by a
    // cross-process lock so two `oracle` invocations racing at once don't
    // both allocate a port and spawn duplicate daemons.
    return this.spawnServiceExclusive(service);
  }

  private async spawnServiceExclusive(
    service: "memory"
  ): Promise<{ endpoint: string; pid: number; port: number } | null> {
    const lockPath = path.join(this.runDir, `${service}.spawn.lock`);
    await fs.mkdir(this.runDir, { recursive: true });

    let handle: fs.FileHandle;
    try {
      // "wx" = exclusive create, fails if the file already exists — the
      // atomic primitive that makes this a real cross-process mutex.
      handle = await fs.open(lockPath, "wx");
    } catch {
      // Another process is already spawning. Wait for it to finish (or the
      // lock to go stale) and adopt whatever it ends up writing.
      return this.waitForSibling(service, lockPath);
    }

    try {
      await handle.close();
      // Re-check: a sibling may have finished spawning between our initial
      // readLockFile() and acquiring this lock.
      const existing = await this.readLockFile(service);
      if (existing && (await this.healthCheck(service, existing.endpoint))) {
        return existing;
      }
      return await this.spawnService(service);
    } finally {
      await fs.unlink(lockPath).catch(() => undefined);
    }
  }

  private async waitForSibling(
    service: "memory",
    lockPath: string
  ): Promise<{ endpoint: string; pid: number; port: number } | null> {
    const STALE_MS = 30_000;
    for (let waited = 0; waited < 15_000; waited += 300) {
      await sleep(300);
      const existing = await this.readLockFile(service);
      if (existing && (await this.healthCheck(service, existing.endpoint))) {
        return existing;
      }
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_MS) {
          // Sibling died mid-spawn without cleaning up its lock — break the
          // deadlock and take over.
          await fs.unlink(lockPath).catch(() => undefined);
          return this.spawnServiceExclusive(service);
        }
      } catch {
        // Lock file gone but no healthy lockfile appeared yet — sibling
        // likely failed; fall through and retry the loop.
      }
    }
    return null;
  }

  private async readLockFile(
    service: "memory"
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

  private async writeLockFile(service: "memory", pid: number, port: number): Promise<void> {
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

  private async removeLockFile(service: "memory"): Promise<void> {
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

  private async healthCheck(service: "memory", endpoint: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), 3000);

      const url = `${endpoint.replace("/mcp", "")}/health`;

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

  private async spawnService(service: "memory"): Promise<{ endpoint: string; pid: number; port: number } | null> {
    const port = await this.findFreePort();
    const command = process.env.ORACLE_MEMORY_BIN || "oracle-memory";

    // Resolve how to actually launch the command cross-platform. A bare
    // ".exe"/POSIX binary spawns directly, but two common install shapes need
    // special handling — otherwise spawn() fails with no pid on Windows and
    // orchestration silently falls back to the file adapter even though the
    // sidecar *is* installed:
    //   - A Node entry script (oracle-memory ships as dist/index.js): launch it
    //     with the current node executable so a bare "*.js" path works when
    //     ORACLE_MEMORY_BIN points straight at the built file.
    //   - An npm shim (.cmd/.bat/.ps1 on Windows): modern Node refuses to spawn
    //     these without a shell for security, so route them through a shell.
    const lower = command.toLowerCase();
    let execCommand = command;
    let execArgs: string[] = [];
    let useShell = false;
    if (/\.(js|mjs|cjs)$/.test(lower)) {
      execCommand = process.execPath;
      execArgs = [command];
    } else if (/\.(cmd|bat|ps1)$/.test(lower)) {
      useShell = true;
    }

    try {
      // oracle-memory takes zero CLI args and reads transport/port from env.
      const proc = spawn(execCommand, execArgs, {
        detached: true,
        stdio: "ignore",
        shell: useShell,
        env: {
          ...process.env,
          ORACLE_MEMORY_PORT: String(port),
          ORACLE_MEMORY_TRANSPORT: "http",
        },
      });

      // Attach the error handler BEFORE checking pid. spawn() failures (e.g.
      // binary not found) emit 'error' asynchronously on the next tick — if
      // no listener is attached yet, Node's default unhandled-'error'
      // behavior is to throw and crash the whole process. This must be the
      // very next line after spawn() returns, not after any check that
      // could throw/return first.
      proc.on("error", () => {
        /* ignore spawn errors — surfaced via the health-check retry loop below */
      });

      const pid = proc.pid;
      if (!pid) throw new Error("Failed to get process ID");

      // Unref so parent doesn't wait for this process
      proc.unref();
      this.activeProcesses.set(service, { process: proc, startTime: Date.now() });

      // Wait for health check to pass (with retry). The budget must cover a
      // cold start, not just a warm ping: oracle-memory (Node + SQLite, with
      // optional vector search) measurably takes ~3s to bind its HTTP server
      // and answer /health, so the old 2s (10×200ms) window missed it by ~1s
      // and orchestration fell back to the file adapter *every* time even
      // though the sidecar was installed and starting fine. 60×200ms = 12s
      // comfortably covers cold start; this cost is paid only on the very
      // first spawn — the daemon then persists (idle-timeout) and later CLI
      // invocations reconnect via the lockfile without re-spawning.
      const endpoint = `http://127.0.0.1:${port}/mcp`;
      let retries = 60;
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
      // Expected, designed condition: the sidecar binary may simply not be
      // installed, in which case the caller (factory) transparently falls back
      // to the file adapter. Keep this at debug level so it matches the
      // factory's fallback logging instead of surfacing a scary error line
      // (on Windows/PowerShell a bare console.error renders as a
      // NativeCommandError). The null return is the real signal.
      console.debug(`[orchestrator] failed to spawn ${service}: ${reason}`);
      return null;
    }
  }

  /**
   * Gracefully shutdown a managed process (if we spawned it).
   * In practice, this is rarely needed since the daemon self-exits on idle timeout.
   */
  async shutdown(service: "memory"): Promise<void> {
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
