/**
 * Entity extraction and knowledge-graph store.
 *
 * File-backed, zero external dependencies. This is a lightweight property
 * graph, not a full triple-store: nodes are canonicalized entities, edges are
 * directional + typed + weighted (weight = number of memories that witness the
 * relation), and retrieval does weighted multi-hop traversal plus shortest-path
 * explain. Extraction is still heuristic (capitalization + a tech keyword list);
 * an optional LLM extractor can be injected via `setExtractor()` for richer,
 * typed triples without changing any of the storage/traversal code below.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { canonical, extractEntities, guessType, inferRelation, type EntityType } from "./graphExtract.js";

export type { EntityType } from "./graphExtract.js";

const GRAPH_DIR = ".oracle-memory/graph";

/** A named entity extracted from memory */
export interface Entity {
  name: string;
  type: EntityType;
  firstSeen: string;
  lastSeen: string;
  memoryIds: string[];
  aliases: string[];
}

/**
 * A directional, typed, weighted relationship between two entities.
 * One aggregated edge per (from, to, relation); `memoryIds` are the memories
 * that witness it, and its length is the edge weight. This replaces the old
 * "one raw edge row per co-occurrence" model that bloated to 100k rows and
 * silently sliced data away.
 */
export interface Edge {
  from: string;      // canonical entity name
  to: string;        // canonical entity name
  relation: string;  // "uses" | "implements" | "depends_on" | "migrates" | "related_to" | ...
  memoryIds: string[];
}

/** A single hop in an explained path. */
export interface PathHop {
  from: string;
  relation: string;
  to: string;
}

/** Pluggable extractor: turn memory content into typed triples. */
export interface ExtractedTriple {
  from: string;
  fromType?: EntityType;
  to: string;
  toType?: EntityType;
  relation: string;
}
export type TripleExtractor = (content: string, tags: string[]) => Promise<ExtractedTriple[]>;

interface GraphData {
  entities: Record<string, Entity>;
  edges: Edge[];
}

/** Hop decay for multi-hop query expansion: score of an entity N hops out. */
const HOP_DECAY = [1, 0.5, 0.25];
const MAX_HOPS = 2;

/** Simple promise-chain mutex for single-process concurrency. */
class KeyedMutex {
  private queue: Promise<void> = Promise.resolve();
  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const prev = this.queue;
    this.queue = this.queue.then(() => wait);
    await prev;
    try {
      return await fn();
    } finally {
      release!();
    }
  }
}

export class EntityGraph {
  private rootDir: string;
  private ready: Promise<void>;
  private cache: GraphData | null = null;
  private mutex = new KeyedMutex();
  private extractor: TripleExtractor | null = null;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.ready = this.init();
  }

  /**
   * Inject an optional LLM (or any) triple extractor. When set, its typed
   * triples are merged with the heuristic co-occurrence edges. Purely additive:
   * everything works without it.
   */
  setExtractor(extractor: TripleExtractor | null): void {
    this.extractor = extractor;
  }

  private async init(): Promise<void> {
    await fs.mkdir(path.join(this.rootDir, GRAPH_DIR), { recursive: true });
  }

  private graphPath(): string {
    return path.join(this.rootDir, GRAPH_DIR, "graph.json");
  }

  private async load(): Promise<GraphData> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.graphPath(), "utf-8");
      this.cache = JSON.parse(raw) as GraphData;
    } catch {
      this.cache = { entities: {}, edges: [] };
    }
    return this.cache;
  }

  private async save(data: GraphData): Promise<void> {
    this.cache = data;
    const tmp = this.graphPath() + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(data), "utf-8");
    await fs.rename(tmp, this.graphPath());
  }

  /** Look up an aggregated edge by its (from, to, relation) key. */
  private findEdge(edges: Edge[], from: string, to: string, relation: string): Edge | undefined {
    return edges.find((e) => e.from === from && e.to === to && e.relation === relation);
  }

  /**
   * Extract entities/relations from memory content and index them in the graph.
   * Idempotent per memoryId: re-indexing first strips the memory's prior
   * contribution, so edge weights never double-count.
   */
  async indexMemory(memoryId: string, content: string, tags: string[]): Promise<void> {
    await this.ready;
    // Run the optional extractor OUTSIDE the mutex (it may be slow / async I/O).
    let triples: ExtractedTriple[] = [];
    if (this.extractor) {
      try { triples = await this.extractor(content, tags); } catch { /* optional */ }
    }

    await this.mutex.acquire(async () => {
      const data = await this.load();
      const ts = new Date().toISOString();

      this.detachMemory(data, memoryId);

      // ── Heuristic entities + weighted co-occurrence edges ──
      const entities = extractEntities(content, tags);
      for (const [name, type] of entities) {
        this.upsertEntity(data, name, type, memoryId, ts);
      }

      const names = entities.map(([name]) => name);
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const { from, to, relation } = inferRelation(content, names[i], names[j]);
          this.upsertEdge(data, from, to, relation, memoryId);
        }
      }

      // ── Typed triples from the optional extractor (higher-quality) ──
      for (const t of triples) {
        const from = canonical(t.from);
        const to = canonical(t.to);
        if (!from || !to || from === to) continue;
        this.upsertEntity(data, from, t.fromType ?? guessType(from), memoryId, ts);
        this.upsertEntity(data, to, t.toType ?? guessType(to), memoryId, ts);
        this.upsertEdge(data, from, to, t.relation || "related_to", memoryId);
      }

      await this.save(data);
    });
  }

  /** Upsert an entity node, merging by canonical name. */
  private upsertEntity(data: GraphData, rawName: string, type: EntityType, memoryId: string, ts: string): void {
    const name = canonical(rawName);
    const existing = data.entities[name];
    if (existing) {
      existing.lastSeen = ts;
      if (!existing.memoryIds.includes(memoryId)) existing.memoryIds.push(memoryId);
      if (type) existing.type = type;
      if (rawName !== name && !existing.aliases.includes(rawName)) existing.aliases.push(rawName);
    } else {
      data.entities[name] = {
        name, type, firstSeen: ts, lastSeen: ts,
        memoryIds: [memoryId],
        aliases: rawName !== name ? [rawName] : [],
      };
    }
  }

  /** Upsert a directional weighted edge (weight = #witnessing memories). */
  private upsertEdge(data: GraphData, rawFrom: string, rawTo: string, relation: string, memoryId: string): void {
    const from = canonical(rawFrom);
    const to = canonical(rawTo);
    if (from === to) return;
    const edge = this.findEdge(data.edges, from, to, relation);
    if (edge) {
      if (!edge.memoryIds.includes(memoryId)) edge.memoryIds.push(memoryId);
    } else {
      data.edges.push({ from, to, relation, memoryIds: [memoryId] });
    }
  }

  /** Strip a memory's contribution to nodes and edges (for re-index / removal). */
  private detachMemory(data: GraphData, memoryId: string): void {
    for (const entity of Object.values(data.entities)) {
      entity.memoryIds = entity.memoryIds.filter((id) => id !== memoryId);
    }
    for (const edge of data.edges) {
      edge.memoryIds = edge.memoryIds.filter((id) => id !== memoryId);
    }
    data.edges = data.edges.filter((e) => e.memoryIds.length > 0);
  }

  /**
   * Find entities matching the query, then do weighted multi-hop traversal to
   * surface related entities. `related` is ordered by traversal score (edge
   * weight × hop decay), strongest first.
   */
  async expandQuery(query: string): Promise<{ entities: string[]; related: string[] }> {
    await this.ready;
    const data = await this.load();

    const directEntities = Object.keys(data.entities).filter((name) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\b`, "i").test(query);
    });

    const scores = new Map<string, number>();
    let frontier = new Set(directEntities);
    const visited = new Set(directEntities);

    for (let hop = 1; hop <= MAX_HOPS && frontier.size > 0; hop++) {
      const next = new Set<string>();
      const decay = HOP_DECAY[hop] ?? 0;
      for (const node of frontier) {
        for (const edge of data.edges) {
          const neighbor = edge.from === node ? edge.to : edge.to === node ? edge.from : null;
          if (!neighbor) continue;
          const gain = edge.memoryIds.length * decay;
          scores.set(neighbor, (scores.get(neighbor) ?? 0) + gain);
          if (!visited.has(neighbor)) { next.add(neighbor); visited.add(neighbor); }
        }
      }
      frontier = next;
    }

    const related = Array.from(scores.entries())
      .filter(([name]) => !directEntities.includes(name))
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);

    return { entities: directEntities, related };
  }

  /**
   * Shortest relation path between two entities (BFS over undirected edges),
   * for "how is A related to B?" explain queries. Returns [] if no path.
   */
  async findPath(fromRaw: string, toRaw: string, maxDepth = 4): Promise<PathHop[]> {
    await this.ready;
    const data = await this.load();
    const from = canonical(fromRaw);
    const to = canonical(toRaw);
    if (from === to || !data.entities[from] || !data.entities[to]) return [];

    const prev = new Map<string, PathHop>();
    const visited = new Set<string>([from]);
    let frontier = [from];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const edge of data.edges) {
          let neighbor: string | null = null;
          let hop: PathHop | null = null;
          if (edge.from === node) { neighbor = edge.to; hop = { from: edge.from, relation: edge.relation, to: edge.to }; }
          else if (edge.to === node) { neighbor = edge.from; hop = { from: edge.to, relation: edge.relation, to: edge.from }; }
          if (!neighbor || visited.has(neighbor)) continue;
          visited.add(neighbor);
          prev.set(neighbor, hop!);
          if (neighbor === to) return this.reconstructPath(prev, to);
          next.push(neighbor);
        }
      }
      frontier = next;
    }
    return [];
  }

  private reconstructPath(prev: Map<string, PathHop>, target: string): PathHop[] {
    const path: PathHop[] = [];
    let cur = target;
    while (prev.has(cur)) {
      const hop = prev.get(cur)!;
      path.unshift(hop);
      cur = hop.from;
    }
    return path;
  }

  /** Memory IDs connected to an entity (node memberships + witnessing edges). */
  async getMemoryIdsForEntity(entityRaw: string): Promise<Set<string>> {
    await this.ready;
    const data = await this.load();
    const entityName = canonical(entityRaw);
    const ids = new Set<string>();

    const entity = data.entities[entityName];
    if (entity) for (const id of entity.memoryIds) ids.add(id);

    for (const edge of data.edges) {
      if (edge.from === entityName || edge.to === entityName) {
        for (const id of edge.memoryIds) ids.add(id);
      }
    }
    return ids;
  }

  /** Remove a memory's entities and edges from the graph. */
  async removeMemory(memoryId: string): Promise<void> {
    await this.ready;
    await this.mutex.acquire(async () => {
      const data = await this.load();
      this.detachMemory(data, memoryId);
      // Drop now-orphaned entities.
      for (const [name, entity] of Object.entries(data.entities)) {
        if (entity.memoryIds.length === 0) delete data.entities[name];
      }
      await this.save(data);
    });
  }

  /** Graph statistics. */
  async getStats(): Promise<{ entityCount: number; edgeCount: number }> {
    await this.ready;
    const data = await this.load();
    return { entityCount: Object.keys(data.entities).length, edgeCount: data.edges.length };
  }
}
