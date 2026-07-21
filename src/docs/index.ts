import fs from "node:fs/promises";
import path from "node:path";
import { chunkDocument, type DocChunk } from "./chunk.js";
import { docsDir } from "./reader.js";

interface IndexedFile {
  name: string;
  mtimeMs: number;
  size: number;
  chunks: DocChunk[];
}

interface IndexFile {
  version: 1;
  files: IndexedFile[];
}

const INDEX_FILENAME = ".index.json";

function indexPath(rootDir: string): string {
  return path.join(docsDir(rootDir), INDEX_FILENAME);
}

async function readIndex(rootDir: string): Promise<IndexFile | null> {
  try {
    const raw = await fs.readFile(indexPath(rootDir), "utf8");
    return JSON.parse(raw) as IndexFile;
  } catch {
    return null;
  }
}

async function writeIndex(rootDir: string, index: IndexFile): Promise<void> {
  const fp = indexPath(rootDir);
  const tmp = `${fp}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(index), "utf8");
  await fs.rename(tmp, fp);
}

/**
 * Build (or incrementally refresh) the chunk index for `.oracle/docs/`.
 * Re-chunking is skipped for files whose mtime/size haven't changed since
 * the cached index was written — chunking is cheap but re-reading/parsing
 * every file on every search doesn't scale once a docs folder grows.
 */
export async function buildDocsIndex(
  rootDir: string,
  files: Array<{ name: string; path: string; content: string }>
): Promise<DocChunk[]> {
  const cached = await readIndex(rootDir);
  const cachedByName = new Map((cached?.files ?? []).map((f) => [f.name, f]));

  const nextFiles: IndexedFile[] = [];
  for (const file of files) {
    let stat;
    try {
      stat = await fs.stat(file.path);
    } catch {
      continue;
    }
    const prior = cachedByName.get(file.name);
    if (prior && prior.mtimeMs === stat.mtimeMs && prior.size === stat.size) {
      nextFiles.push(prior);
      continue;
    }
    nextFiles.push({
      name: file.name,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      chunks: chunkDocument(file.name, file.content),
    });
  }

  await writeIndex(rootDir, { version: 1, files: nextFiles });
  return nextFiles.flatMap((f) => f.chunks);
}

export async function invalidateDocsIndex(rootDir: string): Promise<void> {
  try {
    await fs.unlink(indexPath(rootDir));
  } catch {
    /* nothing to invalidate */
  }
}
