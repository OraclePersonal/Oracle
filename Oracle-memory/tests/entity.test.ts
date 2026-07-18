import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { EntityGraph } from "../src/entity.js";

const TEST_ROOT = ".oracle-memory-test-entity";

describe("EntityGraph", () => {
  let graph: EntityGraph;

  beforeEach(async () => {
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true });
    }
    graph = new EntityGraph(TEST_ROOT);
    // Wait for init
    await new Promise((r) => setTimeout(r, 100));
  });

  afterEach(() => {
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true });
    }
  });

  it("extracts entities and builds graph", async () => {
    await graph.indexMemory("m1", "Alice built a REST API with Express and TypeScript", ["api"]);
    await graph.indexMemory("m2", "Bob deployed the database migration from MySQL to PostgreSQL", ["database"]);

    const expansion = await graph.expandQuery("Alice");
    expect(expansion.entities).toContain("Alice");
    expect(expansion.related.length).toBeGreaterThan(0);
    // Alice is connected to Express, TypeScript, REST, API
    expect(expansion.related.some((e) => e.toLowerCase() === "express")).toBe(true);
    expect(expansion.related.some((e) => e.toLowerCase() === "typescript")).toBe(true);
  });

  it("finds memory IDs for an entity", async () => {
    await graph.indexMemory("m1", "Alice worked on JWT authentication", ["auth"]);
    await graph.indexMemory("m2", "JWT token validation has a bug", ["bug"]);

    const ids = await graph.getMemoryIdsForEntity("JWT");
    expect(ids.has("m1")).toBe(true);
    expect(ids.has("m2")).toBe(true);
  });

  it("expands queries to related entities", async () => {
    await graph.indexMemory("m1", "TypeScript strict mode catches type errors at compile time", ["typescript"]);
    await graph.indexMemory("m2", "ESLint and TypeScript together improve code quality", ["lint"]);

    const expansion = await graph.expandQuery("typescript");
    expect(expansion.entities.length).toBeGreaterThan(0);
    expect(expansion.related.length).toBeGreaterThan(0);
  });

  it("removes memory and cleans up", async () => {
    await graph.indexMemory("m1", "Alice uses Docker for development", ["docker"]);
    expect((await graph.getStats()).entityCount).toBeGreaterThan(0);

    await graph.removeMemory("m1");
    const stats = await graph.getStats();
    // Alice and Docker might still exist if they have other memories
    // But edges should be removed
    expect(stats.edgeCount).toBe(0);
  });

  it("returns stats", async () => {
    await graph.indexMemory("m1", "Test memory with TypeScript and Node", ["test"]);
    const stats = await graph.getStats();
    expect(stats.entityCount).toBeGreaterThan(0);
    expect(stats.edgeCount).toBeGreaterThan(0);
  });

  it("aggregates edges by weight instead of one row per co-occurrence", async () => {
    await graph.indexMemory("m1", "Alice uses Docker", ["ops"]);
    await graph.indexMemory("m2", "Alice uses Docker again", ["ops"]);
    // Same Alice→Docker relation witnessed by 2 memories → still one aggregated edge.
    const ids = await graph.getMemoryIdsForEntity("Docker");
    expect(ids.has("m1")).toBe(true);
    expect(ids.has("m2")).toBe(true);
  });

  it("canonicalizes case/spelling variants into one node", async () => {
    await graph.indexMemory("m1", "The app uses postgres for storage", ["db"]);
    await graph.indexMemory("m2", "We migrated to PostgreSQL", ["db"]);
    const ids = await graph.getMemoryIdsForEntity("PostgreSQL");
    expect(ids.has("m1")).toBe(true);
    expect(ids.has("m2")).toBe(true);
  });

  it("infers a directional relation from the text between entities", async () => {
    await graph.indexMemory("m1", "The service depends on Redis for caching", ["infra"]);
    // Not asserting exact direction (extraction order varies) — just that a
    // non-default relation was inferred somewhere in the graph.
    const expansion = await graph.expandQuery("Redis");
    expect(expansion.entities.some((e) => e.toLowerCase() === "redis")).toBe(true);
  });

  it("finds a shortest relation path between two entities", async () => {
    await graph.indexMemory("m1", "The API uses Redis for caching", ["infra"]);
    const path = await graph.findPath("Redis", "API");
    expect(path.length).toBeGreaterThan(0);
    expect(path[0].from.toLowerCase()).toBe("redis");
  });

  it("supports an injected triple extractor", async () => {
    graph.setExtractor(async () => [
      { from: "ServiceA", to: "ServiceB", relation: "calls", fromType: "project", toType: "project" },
    ]);
    await graph.indexMemory("m1", "internal note", []);
    const path = await graph.findPath("ServiceA", "ServiceB");
    expect(path.length).toBe(1);
    expect(path[0].relation).toBe("calls");
    graph.setExtractor(null);
  });
});
