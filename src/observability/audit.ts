import fs from "node:fs/promises";
import path from "node:path";

export interface AuditRecord {
  timestamp: string;
  action: "read" | "write" | "edit" | "delete" | "bash" | "tool" | "policy_denied";
  target: string;
  agentId?: string;
  details?: Record<string, unknown>;
}

export class AuditLogger {
  private auditFile(workspaceRoot: string): string {
    return path.join(workspaceRoot, ".oracle", "audit.jsonl");
  }

  /**
   * Log an immutable JSON line entry into .oracle/audit.jsonl.
   */
  async log(workspaceRoot: string, record: Omit<AuditRecord, "timestamp">): Promise<void> {
    const entry: AuditRecord = {
      timestamp: new Date().toISOString(),
      ...record,
    };

    const targetDir = path.join(workspaceRoot, ".oracle");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.appendFile(this.auditFile(workspaceRoot), `${JSON.stringify(entry)}\n`, "utf8");
  }

  /**
   * Read recent audit records from workspace.
   */
  async readRecords(workspaceRoot: string, limit = 100): Promise<AuditRecord[]> {
    try {
      const content = await fs.readFile(this.auditFile(workspaceRoot), "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      const records: AuditRecord[] = [];
      for (const line of lines.slice(-limit)) {
        try {
          records.push(JSON.parse(line) as AuditRecord);
        } catch { /* skip corrupt */ }
      }
      return records.reverse();
    } catch {
      return [];
    }
  }
}
