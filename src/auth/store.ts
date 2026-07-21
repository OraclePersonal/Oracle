import fs from "node:fs/promises";
import path from "node:path";

export interface TokenEntry {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  planTier?: string;
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
    const filePath = this.filePath(provider);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // Atomic write via temp file + rename — concurrent CLI invocations (e.g. two
    // commands racing a token refresh) must never observe a partially-written
    // or truncated token file.
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entry, null, 2), "utf8");
    await fs.rename(tmp, filePath);
  }

  async delete(provider: string): Promise<void> {
    try {
      await fs.unlink(this.filePath(provider));
    } catch {
      // ignore
    }
  }
}
