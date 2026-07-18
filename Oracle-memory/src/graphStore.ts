/**
 * SQLite-backed knowledge graph with bi-temporal edges.
 *
 * Same public surface as EntityGraph (entity.ts) — drop-in via the `graphImpl`
 * option on MemoryStore — but backed by an embedded SQLite DB (`node:sqlite`,
 * zero external deps, honoring the file-store philosophy) instead of a single
 * JSON blob. This unlocks:
 *   - indexed traversal (no full-array scans; scales past the 100k edge cap)
 *   - temporal edges: each edge carries validFrom/validTo, so "migrated from
 *     MySQL to PostgreSQL" is two edges with non-overlapping validity, and you
 *     can ask what the graph looked like at a past instant.
 * Storage lives at `.oracle-memory/graph/graph.db`.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  canonical, extractEntities, guessType, inferRelation, type EntityType,
} from "./graphExtract.js";
import type { ExtractedTriple, PathHop, TripleExtractor } from "./entity.js";

const GRAPH_DIR = ".oracle-memory/graph";
const HOP_DECAY = [1, 0.5, 0.25];
const MAX_HOPS = 2;

/** Relations that supersede a prior relation between the same pair (temporal close-out). */
const SUPERSEDING = new Set(["migrates", "implements", "depends_on", "fronts", "uses"]);

export class SqliteGraph {
  private db: DatabaseSync;
  private extractor: TripleExtractor | null = null;

  constructor(rootDir: string) {
    const dir = path.join(rootDir, GRAPH_DIR);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, "graph.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS entities (
        name       TEXT PRIMARY KEY,
        type       TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen  TEXT NOT NULL,
        aliases    TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS entity_memories (
        entity    TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        PRIMARY KEY (entity, memory_id)
      );
      CREATE TABLE IF NOT EXISTS edges (
        from_e     TEXT NOT NULL,
        to_e       TEXT NOT NULL,
        relation   TEXT NOT NULL,
        memory_id  TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to   TEXT,
        PRIMARY KEY (from_e, to_e, relation, memory_id)
      );
      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_e);
      CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges(to_e);
      CREATE INDEX IF NOT EXISTS idx_edges_mem  ON edges(memory_id);
      CREATE INDEX IF NOT EXISTS idx_em_mem     ON entity_memories(memory_id);
    `);
  }

  setExtractor(extractor: TripleExtractor | null): void {
    this.extractor = extractor;
  }

  /** Extract entities/relations and index them. Idempotent per memoryId. */
  async indexMemory(memoryId: string, content: string, tags: string[]): Promise<void> {
    let triples: ExtractedTriple[] = [];
    if (this.extractor) {
      try { triples = await this.extractor(content, tags); } catch { /* optional */ }
    }
    const ts = new Date().toISOString();

    this.detach(memoryId);

    const entities = extractEntities(content, tags);
    for (const [name, type] of entities) this.upsertEntity(name, type, memoryId, ts);

    const names = entities.map(([n]) => n);
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const { from, to, relation } = inferRelation(content, names[i], names[j]);
        this.upsertEdge(from, to, relation, memoryId, ts);
      }
    }

    for (const t of triples) {
      const from = canonical(t.from);
      const to = canonical(t.to);
      if (!from || !to || from === to) continue;
      this.upsertEntity(from, t.fromType ?? guessType(from), memoryId, ts);
      this.upsertEntity(to, t.toType ?? guessType(to), memoryId, ts);
      this.upsertEdge(from, to, t.relation || "related_to", memoryId, ts);
    }
  }

  private upsertEntity(rawName: string, type: EntityType, memoryId: string, ts: string): void {
    const name = canonical(rawName);
    const row = this.db.prepare("SELECT aliases FROM entities WHERE name = ?").get(name) as
      | { aliases: string }
      | undefined;
    if (row) {
      const aliases: string[] = JSON.parse(row.aliases);
      if (rawName !== name && !aliases.includes(rawName)) aliases.push(rawName);
      this.db.prepare("UPDATE entities SET type = ?, last_seen = ?, aliases = ? WHERE name = ?")
        .run(type, ts, JSON.stringify(aliases), name);
    } else {
      this.db.prepare("INSERT INTO entities (name, type, first_seen, last_seen, aliases) VALUES (?, ?, ?, ?, ?)")
        .run(name, type, ts, ts, JSON.stringify(rawName !== name ? [rawName] : []));
    }
    this.db.prepare("INSERT OR IGNORE INTO entity_memories (entity, memory_id) VALUES (?, ?)")
      .run(name, memoryId);
  }

  private upsertEdge(rawFrom: string, rawTo: string, relation: string, memoryId: string, ts: string): void {
    const from = canonical(rawFrom);
    const to = canonical(rawTo);
    if (from === to) return;

    // Temporal close-out: a superseding relation between the same pair closes
    // any still-open edges for that pair from a different memory (e.g. a later
    // "migrates" note ends an earlier "uses"). validTo marks when it stopped.
    if (SUPERSEDING.has(relation)) {
      this.db.prepare(
        `UPDATE edges SET valid_to = ?
         WHERE from_e = ? AND to_e = ? AND valid_to IS NULL AND memory_id != ?`,
      ).run(ts, from, to, memoryId);
    }

    this.db.prepare(
      `INSERT OR IGNORE INTO edges (from_e, to_e, relation, memory_id, valid_from, valid_to)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(from, to, relation, memoryId, ts);
  }

  private detach(memoryId: string): void {
    this.db.prepare("DELETE FROM edges WHERE memory_id = ?").run(memoryId);
    this.db.prepare("DELETE FROM entity_memories WHERE memory_id = ?").run(memoryId);
    // Drop entities that no longer back any memory.
    this.db.exec(
      "DELETE FROM entities WHERE name NOT IN (SELECT DISTINCT entity FROM entity_memories)",
    );
  }

  async removeMemory(memoryId: string): Promise<void> {
    this.detach(memoryId);
  }

  /** Edges currently valid at `asOf` (default: now). A null valid_to is open. */
  private validEdges(asOf?: string): { from_e: string; to_e: string; relation: string; memory_id: string }[] {
    if (!asOf) {
      return this.db.prepare("SELECT from_e, to_e, relation, memory_id FROM edges WHERE valid_to IS NULL")
        .all() as any[];
    }
    return this.db.prepare(
      `SELECT from_e, to_e, relation, memory_id FROM edges
       WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`,
    ).all(asOf, asOf) as any[];
  }

  /** Weighted multi-hop expansion. `asOf` optionally queries a past graph state. */
  async expandQuery(query: string, asOf?: string): Promise<{ entities: string[]; related: string[] }> {
    const allNames = (this.db.prepare("SELECT name FROM entities").all() as { name: string }[]).map((r) => r.name);
    const direct = allNames.filter((name) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\b`, "i").test(query);
    });

    const edges = this.validEdges(asOf);
    const scores = new Map<string, number>();
    let frontier = new Set(direct);
    const visited = new Set(direct);

    for (let hop = 1; hop <= MAX_HOPS && frontier.size > 0; hop++) {
      const next = new Set<string>();
      const decay = HOP_DECAY[hop] ?? 0;
      for (const node of frontier) {
        for (const e of edges) {
          const neighbor = e.from_e === node ? e.to_e : e.to_e === node ? e.from_e : null;
          if (!neighbor) continue;
          scores.set(neighbor, (scores.get(neighbor) ?? 0) + decay);
          if (!visited.has(neighbor)) { next.add(neighbor); visited.add(neighbor); }
        }
      }
      frontier = next;
    }

    const related = Array.from(scores.entries())
      .filter(([name]) => !direct.includes(name))
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);

    return { entities: direct, related };
  }

  /** Shortest relation path (BFS over currently-valid undirected edges). */
  async findPath(fromRaw: string, toRaw: string, maxDepth = 4, asOf?: string): Promise<PathHop[]> {
    const from = canonical(fromRaw);
    const to = canonical(toRaw);
    if (from === to) return [];
    const exists = (n: string) => !!this.db.prepare("SELECT 1 FROM entities WHERE name = ?").get(n);
    if (!exists(from) || !exists(to)) return [];

    const edges = this.validEdges(asOf);
    const prev = new Map<string, PathHop>();
    const visited = new Set<string>([from]);
    let frontier = [from];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const e of edges) {
          let neighbor: string | null = null;
          let hop: PathHop | null = null;
          if (e.from_e === node) { neighbor = e.to_e; hop = { from: e.from_e, relation: e.relation, to: e.to_e }; }
          else if (e.to_e === node) { neighbor = e.from_e; hop = { from: e.to_e, relation: e.relation, to: e.from_e }; }
          if (!neighbor || visited.has(neighbor)) continue;
          visited.add(neighbor);
          prev.set(neighbor, hop!);
          if (neighbor === to) return this.reconstruct(prev, to);
          next.push(neighbor);
        }
      }
      frontier = next;
    }
    return [];
  }

  private reconstruct(prev: Map<string, PathHop>, target: string): PathHop[] {
    const out: PathHop[] = [];
    let cur = target;
    while (prev.has(cur)) {
      const hop = prev.get(cur)!;
      out.unshift(hop);
      cur = hop.from;
    }
    return out;
  }

  async getMemoryIdsForEntity(entityRaw: string): Promise<Set<string>> {
    const name = canonical(entityRaw);
    const ids = new Set<string>();
    for (const r of this.db.prepare("SELECT memory_id FROM entity_memories WHERE entity = ?").all(name) as any[]) {
      ids.add(r.memory_id);
    }
    for (const r of this.db.prepare("SELECT memory_id FROM edges WHERE from_e = ? OR to_e = ?").all(name, name) as any[]) {
      ids.add(r.memory_id);
    }
    return ids;
  }

  async getStats(): Promise<{ entityCount: number; edgeCount: number }> {
    const e = this.db.prepare("SELECT COUNT(*) AS c FROM entities").get() as { c: number };
    const g = this.db.prepare("SELECT COUNT(*) AS c FROM edges WHERE valid_to IS NULL").get() as { c: number };
    return { entityCount: e.c, edgeCount: g.c };
  }

  close(): void {
    this.db.close();
  }
}
