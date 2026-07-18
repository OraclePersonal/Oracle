import { LocalIndex } from "vectra";
import { LocalEmbeddings } from "vectra";
import path from "node:path";
import type { MemoryType } from "./types.js";

const INDEX_DIR = ".oracle-memory/vectors";

export interface VectorSearchResult {
  id: string;
  score: number;
}

export class VectorStore {
  private index: LocalIndex;
  private embeddings: LocalEmbeddings;
  private ready: Promise<void>;

  constructor(rootDir: string) {
    const indexDir = path.join(rootDir, INDEX_DIR);
    this.embeddings = new LocalEmbeddings({
      model: "Xenova/all-MiniLM-L6-v2",
      maxTokens: 256,
    });
    this.index = new LocalIndex(indexDir);
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    if (!(await this.index.isIndexCreated())) {
      await this.index.createIndex({ version: 1, deleteIfExists: false });
    }
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  async addMemory(
    memoryId: string,
    type: MemoryType,
    agent: string,
    content: string,
    tags: string[],
  ): Promise<void> {
    await this.ensureReady();
    const text = `${type}: ${content}\ntags: ${tags.join(", ")}`;

    try {
      const response = await this.embeddings.createEmbeddings(text);
      if (!response.status || !response.output?.length) {
        return;
      }

      await this.index.insertItem({
        vector: response.output[0],
        metadata: { memoryId, type, agent },
      });
    } catch (e) {
      console.error("vectra: failed to index memory", memoryId, (e as Error).message);
    }
  }

  async removeMemory(memoryId: string): Promise<void> {
    await this.ensureReady();
    try {
      const items = await this.index.listItems();
      for (const item of items) {
        if ((item.metadata as Record<string, string>)?.memoryId === memoryId) {
          await this.index.deleteItem(item.id);
        }
      }
    } catch {
      // ignore errors during removal
    }
  }

  async search(query: string, topK: number = 20): Promise<VectorSearchResult[]> {
    await this.ensureReady();
    try {
      const response = await this.embeddings.createEmbeddings(query);
      if (!response.status || !response.output?.length) {
        return [];
      }

      // Semantic search only (BM25 handled separately in hybrid fusion)
      const results = await this.index.queryItems(
        response.output[0],
        query,
        topK,
        undefined,
        false,
      );

      return results.map((r) => ({
        id: (r.item.metadata as { memoryId: string }).memoryId,
        score: r.score,
      }));
    } catch (e) {
      console.error("vectra: search failed", (e as Error).message);
      return [];
    }
  }

  async clear(): Promise<void> {
    await this.ensureReady();
    try {
      await this.index.deleteIndex();
      await this.index.createIndex({ version: 1, deleteIfExists: false });
    } catch {
      // ignore
    }
  }
}
