import fs from "node:fs/promises";
import path from "node:path";
import { bm25Search } from "./bm25.js";
import { buildDocsIndex, invalidateDocsIndex } from "./index.js";

export interface DocEntry {
  name: string;
  path: string;
  content: string;
  size: number;
}

export interface DocSearchResult {
  name: string;
  heading: string;
  snippet: string;
  score: number;
  size: number;
}

const DOCS_DIR = ".oracle/docs";
const ALLOWED_EXTS = [".md", ".txt", ".json", ".mdx"];
const INDEX_FILENAME = ".index.json";

export function docsDir(rootDir: string): string {
  return path.join(rootDir, DOCS_DIR);
}

export async function listDocs(rootDir: string): Promise<DocEntry[]> {
  const dir = docsDir(rootDir);
  try {
    const entries: DocEntry[] = [];
    const files = await walk(dir, ALLOWED_EXTS);
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

/**
 * BM25-ranked passage search over `.oracle/docs/`. Each file is chunked
 * (by markdown heading, hard-wrapped past ~1200 chars) and cached in
 * `.oracle/docs/.index.json` so repeated searches don't re-chunk unchanged
 * files. Returns individual passages, not whole files — a doc can be long
 * enough that "relevant" and "whole file" stop meaning the same thing.
 */
export async function searchDocs(rootDir: string, query: string, limit = 10): Promise<DocSearchResult[]> {
  const docs = await listDocs(rootDir);
  if (docs.length === 0) return [];
  const sizeByName = new Map(docs.map((d) => [d.name, d.size]));
  const chunks = await buildDocsIndex(rootDir, docs);
  const hits = bm25Search(
    chunks.map((c) => ({ id: c.id, text: c.heading ? `${c.heading}\n${c.content}` : c.content })),
    query,
    limit
  );
  const chunkById = new Map(chunks.map((c) => [c.id, c]));
  return hits
    .map((hit) => {
      const chunk = chunkById.get(hit.id);
      if (!chunk) return null;
      const name = hit.id.slice(0, hit.id.lastIndexOf("#"));
      return {
        name,
        heading: chunk.heading,
        snippet: chunk.content.slice(0, 1000),
        score: hit.score,
        size: sizeByName.get(name) ?? chunk.content.length,
      };
    })
    .filter((r): r is DocSearchResult => r !== null);
}

export async function addDoc(rootDir: string, name: string, content: string): Promise<string> {
  if (!ALLOWED_EXTS.some((ext) => name.endsWith(ext))) {
    throw new Error(`Unsupported doc extension. Use one of: ${ALLOWED_EXTS.join(", ")}`);
  }
  const dir = docsDir(rootDir);
  const filePath = path.join(dir, name);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(dir) + path.sep) && resolved !== path.resolve(dir)) {
    throw new Error(`Invalid doc name: ${name}`);
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  await invalidateDocsIndex(rootDir);
  return filePath;
}

export async function removeDoc(rootDir: string, name: string): Promise<boolean> {
  const dir = docsDir(rootDir);
  const filePath = path.join(dir, name);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
    throw new Error(`Invalid doc name: ${name}`);
  }
  try {
    await fs.unlink(filePath);
    await invalidateDocsIndex(rootDir);
    return true;
  } catch {
    return false;
  }
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
      } else if (entry.isFile() && entry.name !== INDEX_FILENAME && exts.some((e) => entry.name.endsWith(e))) {
        result.push(fullPath);
      }
    }
  } catch {}
  return result;
}
