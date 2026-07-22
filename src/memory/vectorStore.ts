import fs from "node:fs/promises";
import path from "node:path";
import { generateEmbedding, cosineSimilarity } from "./ollama.js";

interface VectorRecord {
  memoryId: string;
  embedding: number[];
  updatedAt: string;
}

export class VectorStore {
  private records: VectorRecord[] = [];
  private dirty = false;
  private filePath: string;

  constructor(rootDir: string, dataDirectory = ".oracle-memory") {
    this.filePath = path.join(rootDir, dataDirectory, "vectors.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.records = JSON.parse(raw) as VectorRecord[];
    } catch { this.records = []; }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(this.records), "utf8");
      this.dirty = false;
    } catch { /* ignore write errors */ }
  }

  async index(memoryId: string, content: string): Promise<void> {
    const emb = await generateEmbedding(content);
    if (!emb) return;
    const idx = this.records.findIndex((r) => r.memoryId === memoryId);
    const record: VectorRecord = { memoryId, embedding: emb.embedding, updatedAt: new Date().toISOString() };
    if (idx >= 0) this.records[idx] = record;
    else this.records.push(record);
    this.dirty = true;
    void this.save();
  }

  async remove(memoryId: string): Promise<void> {
    const len = this.records.length;
    this.records = this.records.filter((r) => r.memoryId !== memoryId);
    if (this.records.length !== len) { this.dirty = true; void this.save(); }
  }

  search(queryEmbedding: number[], topK = 10): { memoryId: string; score: number }[] {
    const scored = this.records.map((r) => ({
      memoryId: r.memoryId,
      score: cosineSimilarity(queryEmbedding, r.embedding),
    }));
    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }
}
