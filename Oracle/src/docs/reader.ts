import fs from "node:fs/promises";
import path from "node:path";

export interface DocEntry {
  name: string;
  path: string;
  content: string;
  size: number;
}

const DOCS_DIR = ".oracle/docs";

export function docsDir(rootDir: string): string {
  return path.join(rootDir, DOCS_DIR);
}

export async function listDocs(rootDir: string): Promise<DocEntry[]> {
  const dir = docsDir(rootDir);
  try {
    const entries: DocEntry[] = [];
    const files = await walk(dir, [".md", ".txt", ".json", ".mdx"]);
    for (const file of files) {
      const content = await fs.readFile(file, "utf8");
      entries.push({
        name: path.relative(dir, file),
        path: file,
        content,
        size: content.length,
      });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function searchDocs(rootDir: string, query: string): Promise<DocEntry[]> {
  const q = query.toLowerCase();
  const words = q.split(/\s+/).filter((w) => w.length > 2);
  const docs = await listDocs(rootDir);
  return docs
    .map((d) => {
      const lowerContent = d.content.toLowerCase();
      const lowerName = d.name.toLowerCase();
      // Score: exact query match in content = 3, name match = 2, any keyword matches = count sum
      let score = 0;
      if (lowerContent.includes(q)) score += 3;
      if (lowerName.includes(q)) score += 2;
      for (const w of words) {
        if (lowerContent.includes(w)) score += 1;
        if (lowerName.includes(w)) score += 1;
      }
      return { doc: d, score };
    })
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((d) => d.doc);
}

async function walk(dir: string, exts: string[]): Promise<string[]> {
  const result: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // ponytail: skip node_modules, .git
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        result.push(...(await walk(fullPath, exts)));
      } else if (entry.isFile() && exts.some((e) => entry.name.endsWith(e))) {
        result.push(fullPath);
      }
    }
  } catch {}
  return result;
}
