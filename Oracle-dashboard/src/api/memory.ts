import { Router, type Request, type Response } from "express";
import fs from "node:fs/promises";
import path from "node:path";

const MEMORY_DIR = path.resolve(process.cwd(), "..", "Oracle-memory", ".oracle-memory");

interface MemoryStats {
  facts: number;
  insights: number;
  chunks: number;
  working: number;
  total: number;
  dir: string;
  exists: boolean;
}

async function countFiles(dir: string): Promise<number> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).length;
  } catch {
    return 0;
  }
}

async function getMemoryStats(): Promise<MemoryStats> {
  let exists = false;
  try {
    await fs.access(MEMORY_DIR);
    exists = true;
  } catch {
    /* not found */
  }

  const [facts, insights, chunks, working] = await Promise.all([
    countFiles(path.join(MEMORY_DIR, "facts")),
    countFiles(path.join(MEMORY_DIR, "insights")),
    countFiles(path.join(MEMORY_DIR, "chunks")),
    countFiles(path.join(MEMORY_DIR, "working")),
  ]);

  return {
    facts,
    insights,
    chunks,
    working,
    total: facts + insights + chunks + working,
    dir: MEMORY_DIR,
    exists,
  };
}

export const memoryRouter = Router();

memoryRouter.get("/", async (_req: Request, res: Response) => {
  const stats = await getMemoryStats();
  res.json(stats);
});
