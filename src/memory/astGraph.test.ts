import { describe, expect, it } from "vitest";
import { extractCodeDependencies } from "./astGraph.js";
import { computeDecayScore, identifyStaleMemories } from "./decay.js";
import type { MemoryStoreEntry } from "./adapter.js";

describe("AST Dependency Extractor", () => {
  it("extracts TypeScript import and export symbols", () => {
    const code = `
      import { MemoryAdapter, MemoryType } from "./adapter.js";
      import path from "node:path";

      export interface Config { key: string }
      export class Service {}
      export function run() {}
    `;

    const deps = extractCodeDependencies(code, "src/service.ts");
    expect(deps.moduleName).toBe("service.ts");
    expect(deps.imports).toContain("MemoryAdapter");
    expect(deps.imports).toContain("MemoryType");
    expect(deps.exports).toContain("Config");
    expect(deps.exports).toContain("Service");
    expect(deps.exports).toContain("run");
  });
});

describe("Temporal Memory Decay Engine", () => {
  it("boosts frequently accessed memories", () => {
    const now = Date.now();
    const entry: MemoryStoreEntry = {
      id: "1",
      ts: new Date(now).toISOString(),
      agent: "test",
      type: "fact",
      content: "Important architecture note",
      tags: [],
      meta: {},
      importance: 0.9,
      accessCount: 10,
      lastAccessed: new Date(now).toISOString(),
      decayRate: 0.01,
    };

    const score = computeDecayScore(entry, now);
    expect(score).toBeGreaterThan(0.6);
  });

  it("identifies stale memories older than threshold", () => {
    const now = Date.now();
    const ninetyDaysAgo = new Date(now - 90 * 86_400_000).toISOString();
    const staleEntry: MemoryStoreEntry = {
      id: "2",
      ts: ninetyDaysAgo,
      agent: "test",
      type: "working",
      content: "Temp debug log",
      tags: [],
      meta: {},
      importance: 0.1,
      accessCount: 0,
      lastAccessed: ninetyDaysAgo,
      decayRate: 1.5,
    };

    const staleList = identifyStaleMemories([staleEntry], now);
    expect(staleList).toHaveLength(1);
    expect(staleList[0].id).toBe("2");
  });
});
