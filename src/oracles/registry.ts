import fs from "node:fs/promises";
import path from "node:path";
import type { OracleProfile, Workshop } from "./types.js";

// ponytail: flat JSON files for oracle profiles only.
// Memory moved to memory adapter (writes .oracle-memory/ format).

export class OracleRegistry {
  constructor(
    private readonly rootDir: string,
    private readonly projectDir?: string
  ) {}

  private oraclesDir(): string {
    return path.join(this.rootDir, "oracles");
  }

  private oraclePath(name: string): string {
    return path.join(this.oraclesDir(), `${name}.json`);
  }

  async listOracles(): Promise<OracleProfile[]> {
    const dir = this.oraclesDir();
    try {
      const files = await fs.readdir(dir);
      const profiles: OracleProfile[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        profiles.push(JSON.parse(await fs.readFile(path.join(dir, file), "utf8")));
      }
      return profiles.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  async getOracle(name: string): Promise<OracleProfile | null> {
    try {
      return JSON.parse(await fs.readFile(this.oraclePath(name), "utf8"));
    } catch {
      return null;
    }
  }

  async registerOracle(profile: OracleProfile): Promise<void> {
    const dir = this.oraclesDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.oraclePath(profile.name), JSON.stringify(profile, null, 2), "utf8");
  }

  async unregisterOracle(name: string): Promise<void> {
    try {
      await fs.unlink(this.oraclePath(name));
    } catch { /* ignore */ }
  }

  // ── Workshop ──

  private workshopPath(): string | null {
    return this.projectDir ? path.join(this.projectDir, ".oracle", "workshop.json") : null;
  }

  async loadWorkshop(): Promise<Workshop | null> {
    const wp = this.workshopPath();
    if (!wp) return null;
    try {
      return JSON.parse(await fs.readFile(wp, "utf8"));
    } catch {
      return null;
    }
  }

  async saveWorkshop(workshop: Workshop): Promise<void> {
    const wp = this.workshopPath();
    if (!wp) throw new Error("No project directory configured for workshop.");
    await fs.mkdir(path.dirname(wp), { recursive: true });
    await fs.writeFile(wp, JSON.stringify(workshop, null, 2), "utf8");
  }

  // ── Export / Import ──

  async exportOracle(name: string): Promise<Record<string, unknown>> {
    const profile = await this.getOracle(name);
    if (!profile) throw new Error(`Oracle not found: ${name}`);
    return { profile } as Record<string, unknown>;
  }

  async importOracle(data: { profile: OracleProfile }): Promise<void> {
    await this.registerOracle(data.profile);
  }
}
