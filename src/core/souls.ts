import fs from "node:fs/promises";
import path from "node:path";

const SOUL_CACHE = new Map<string, string>();

const FALLBACK_SOUL = "You are Oracle, a senior engineer. Answer concisely and directly.";

/** Load a soul prompt (`<dir>/<name>.md`), falling back to `default.md`, then a minimal built-in prompt. */
export async function loadSoul(name: string, dir: string): Promise<string> {
  const key = `${dir}:${name}`;
  const cached = SOUL_CACHE.get(key);
  if (cached) return cached;
  const [file, defaultFile] = [`${name}.md`, "default.md"];
  for (const f of [file, defaultFile]) {
    try {
      const content = await fs.readFile(path.join(dir, f), "utf-8");
      SOUL_CACHE.set(key, content);
      return content;
    } catch {}
  }
  return FALLBACK_SOUL;
}
