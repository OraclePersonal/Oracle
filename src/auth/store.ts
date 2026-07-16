import fs from "node:fs/promises";
import path from "node:path";

export interface TokenEntry {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export class TokenStore {
  constructor(private readonly rootDir: string) {}

  private filePath(provider: string): string {
    return path.join(this.rootDir, "auth", `${provider}.json`);
  }

  async read(provider: string): Promise<TokenEntry | null> {
    try {
      return JSON.parse(await fs.readFile(this.filePath(provider), "utf8")) as TokenEntry;
    } catch {
      return null;
    }
  }

  async write(provider: string, entry: TokenEntry): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath(provider)), { recursive: true });
    await fs.writeFile(this.filePath(provider), JSON.stringify(entry, null, 2), "utf8");
  }

  async delete(provider: string): Promise<void> {
    try {
      await fs.unlink(this.filePath(provider));
    } catch {
      // ignore
    }
  }
}
