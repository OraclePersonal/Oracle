import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Agent presence registry for the message bus. One JSON file per agent under
 * ~/.oracle/agents/, updated with the same atomic tmp+rename pattern as the
 * message store. Registration is self-service: an agent "exists" once it
 * registers, and every bus interaction (send/inbox/ack) touches lastSeen, so
 * the roster doubles as a liveness view without any daemon.
 */

export interface AgentRecord {
  name: string;
  role?: string;
  registeredAt: string;
  lastSeen: string;
}

/** Agents seen within this window count as "active". */
export const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

export class AgentRegistry {
  constructor(private readonly homeDir: string) {}

  private dir(): string {
    return path.join(this.homeDir, "agents");
  }

  private filePath(name: string): string {
    if (!/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(name)) {
      throw new Error(
        `Invalid agent name "${name}": use 1-64 letters/digits/hyphens/underscores, starting with a letter or digit.`
      );
    }
    return path.join(this.dir(), `${name.toLowerCase()}.json`);
  }

  private async writeAtomic(filePath: string, record: AgentRecord): Promise<void> {
    const tmp = `${filePath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
    await fs.rename(tmp, filePath);
  }

  /** Register (or re-register) an agent. Idempotent; preserves registeredAt. */
  async register(name: string, role?: string): Promise<AgentRecord> {
    await fs.mkdir(this.dir(), { recursive: true });
    const filePath = this.filePath(name);
    const existing = await this.get(name);
    const now = new Date().toISOString();
    const record: AgentRecord = {
      name: name.toLowerCase(),
      role: role ?? existing?.role,
      registeredAt: existing?.registeredAt ?? now,
      lastSeen: now,
    };
    await this.writeAtomic(filePath, record);
    return record;
  }

  async get(name: string): Promise<AgentRecord | null> {
    try {
      return JSON.parse(await fs.readFile(this.filePath(name), "utf8")) as AgentRecord;
    } catch {
      return null;
    }
  }

  /**
   * Update lastSeen for an agent if it is registered. Unregistered names are
   * ignored (never throws) — presence must not break bus operations.
   */
  async touch(name: string): Promise<void> {
    try {
      const existing = await this.get(name);
      if (!existing) return;
      existing.lastSeen = new Date().toISOString();
      await this.writeAtomic(this.filePath(name), existing);
    } catch {
      /* presence is best-effort */
    }
  }

  /** All registered agents, most recently seen first, with an active flag. */
  async list(): Promise<Array<AgentRecord & { active: boolean }>> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir());
    } catch {
      return [];
    }
    const records = await Promise.all(
      entries
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          try {
            return JSON.parse(await fs.readFile(path.join(this.dir(), f), "utf8")) as AgentRecord;
          } catch {
            return null;
          }
        })
    );
    const now = Date.now();
    return records
      .filter((r): r is AgentRecord => r !== null && typeof r.name === "string" && typeof r.lastSeen === "string")
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
      .map((r) => ({ ...r, active: now - Date.parse(r.lastSeen) < ACTIVE_WINDOW_MS }));
  }

  /**
   * Return agents whose lastSeen is older than `windowMs`. Defaults to 2x the
   * active window (20 min). Use to detect crashed/abandoned agents.
   */
  async stale(windowMs: number = ACTIVE_WINDOW_MS * 2): Promise<AgentRecord[]> {
    const all = await this.list();
    const cutoff = Date.now() - windowMs;
    return all.filter((a) => Date.parse(a.lastSeen) < cutoff);
  }

  /** Remove an agent's registration file. Used on graceful shutdown. */
  async unregister(name: string): Promise<boolean> {
    try {
      await fs.rm(this.filePath(name));
      return true;
    } catch {
      return false;
    }
  }
}
