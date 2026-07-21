/**
 * Audit trail: track file mutations by the agent for transparency and debugging.
 * Stored alongside session transcript, answers "what did the agent actually change?"
 */

export interface FileChange {
  timestamp: string;
  type: "read" | "write" | "edit" | "delete" | "list";
  path: string;
  sizeBytes?: number;
  contentHash?: string;
  error?: string;
}

export class AuditTrail {
  private changes: FileChange[] = [];

  record(type: FileChange["type"], path: string, details?: Omit<FileChange, "timestamp" | "type" | "path">): void {
    this.changes.push({
      timestamp: new Date().toISOString(),
      type,
      path,
      ...details,
    });
  }

  getChanges(): FileChange[] {
    return [...this.changes];
  }

  getMutations(): FileChange[] {
    return this.changes.filter((c) => ["write", "edit", "delete"].includes(c.type));
  }

  getSummary(): {
    totalChanges: number;
    mutations: number;
    byType: Record<string, number>;
    filesChanged: string[];
  } {
    const byType: Record<string, number> = {};
    const filesChanged = new Set<string>();

    for (const change of this.changes) {
      byType[change.type] = (byType[change.type] ?? 0) + 1;
      if (["write", "edit", "delete"].includes(change.type)) {
        filesChanged.add(change.path);
      }
    }

    return {
      totalChanges: this.changes.length,
      mutations: this.getMutations().length,
      byType,
      filesChanged: Array.from(filesChanged),
    };
  }

  toJSON(): FileChange[] {
    return this.changes;
  }
}
