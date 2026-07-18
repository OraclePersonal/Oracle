import { Router, type Request, type Response } from "express";
import fs from "node:fs/promises";
import path from "node:path";

const MESSAGES_DIR = path.resolve(process.cwd(), "..", "Oracle-messages", ".oracle", "messages");

interface MessageStats {
  totalFiles: number;
  jsonFiles: number;
  recent: string[];
  dir: string;
  exists: boolean;
}

async function getMessageStats(): Promise<MessageStats> {
  let exists = false;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(MESSAGES_DIR);
    exists = true;
  } catch {
    /* not found */
  }

  const jsonFiles = entries.filter((e) => e.endsWith(".json"));
  const recent = jsonFiles.slice(-10).reverse();

  return {
    totalFiles: entries.length,
    jsonFiles: jsonFiles.length,
    recent,
    dir: MESSAGES_DIR,
    exists,
  };
}

export const messagesRouter = Router();

messagesRouter.get("/", async (_req: Request, res: Response) => {
  const stats = await getMessageStats();
  res.json(stats);
});
