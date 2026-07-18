/**
 * oracle-memory comprehensive benchmark runner.
 *
 *   npm run bench                         # full suite (quality + latency + scale)
 *   npm run bench -- --quick              # quality + latency only (skip scale)
 *   npm run bench -- --compare            # also run vectors-vs-no-vectors comparison
 *   ORACLE_MEMORY_LLM_GRAPH=1 npm run bench   # also exercises LLM detectors
 *
 * Phases:
 *   1. Quality  — recall@k, MRR, temporal accuracy (existing dataset)
 *   2. Latency  — remember / search / forget / consolidate timing
 *   3. Scale    — recall quality + latency at 100, 250, 500 memories
 *   4. Storage  — disk usage per config
 *   5. Compare  — vectors vs no-vectors (--compare only)
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "../src/memory.js";
import { RETRIEVAL, SEED, TEMPORAL, TEMPORAL_MEMORIES } from "./dataset.js";
import { generateScaleMemories, SCALE_POINTS } from "./scale-dataset.js";
import { renderBenchSvg } from "./svg.js";

const ROOT = ".oracle-memory-bench";
const K = 5;
const AGENT = "bench";
// ponytail: warmup iterations to JIT the vectra model download before timed runs
const WARMUP = 3;
const ITERATIONS = 10;

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function avg(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

interface PhaseResult {
  phase: string;
  config: string;
  metrics: Record<string, string | number>;
}

async function measureDiskUsage(dir: string): Promise<{ total: number; entries: { size: number }[] }> {
  const { stat, readdir } = await import("node:fs/promises");
  const entries: { size: number }[] = [];
  let total = 0;
  try {
    async function walk(d: string): Promise<void> {
      let names: string[];
      try { names = await readdir(d); } catch { return; }
      for (const name of names) {
        const fp = path.join(d, name);
        let s;
        try { s = await stat(fp); } catch { continue; }
        if (s.isDirectory()) { await walk(fp); }
        else { entries.push({ size: s.size }); total += s.size; }
      }
    }
    await walk(dir);
  } catch { /* dir may not exist */ }
  return { total, entries };
}

// ── Phase 1: Quality ─────────────────────────────────────────────────────

async function phaseQuality(memory: MemoryStore, disableVectors: boolean): Promise<PhaseResult> {
  const keyToId = new Map<string, string>();
  for (const m of SEED) {
    const e = await memory.remember(AGENT, m.type, m.content, {
      tags: m.tags, confidence: m.confidence, sourceTrust: m.sourceTrust,
    });
    keyToId.set(m.key, e.id);
  }
  if (!disableVectors) await new Promise((r) => setTimeout(r, 1500));

  let hits = 0;
  let totalRelevant = 0;
  let mrrSum = 0;
  for (const c of RETRIEVAL) {
    const results = await memory.searchMemories({ query: c.query, limit: K });
    const gotIds = results.map((r) => r.entry.id);
    const relevantIds = c.relevant.map((k) => keyToId.get(k)!);
    totalRelevant += relevantIds.length;
    for (const rid of relevantIds) if (gotIds.includes(rid)) hits++;
    const firstRank = gotIds.findIndex((id) => relevantIds.includes(id));
    if (firstRank >= 0) mrrSum += 1 / (firstRank + 1);
  }
  const recallAtK = hits / totalRelevant;
  const mrr = mrrSum / RETRIEVAL.length;

  // Temporal
  let temporalPass = 0;
  for (const t of TEMPORAL) {
    const troot = `${ROOT}-t-${t.originalKey}`;
    if (existsSync(troot)) rmSync(troot, { recursive: true });
    const tmem = new MemoryStore(troot, !disableVectors);
    const orig = TEMPORAL_MEMORIES[t.originalKey];
    const upd = TEMPORAL_MEMORIES[t.updateKey];
    await tmem.remember(AGENT, orig.type, orig.content, { tags: orig.tags, confidence: orig.confidence, sourceTrust: orig.sourceTrust });
    await tmem.remember(AGENT, upd.type, upd.content, { tags: upd.tags, confidence: upd.confidence, sourceTrust: upd.sourceTrust });
    if (!disableVectors) await new Promise((r) => setTimeout(r, 800));
    const results = await tmem.searchMemories({ query: t.query, limit: K });
    const blob = results.map((r) => r.entry.content).join(" \n ");
    const returnsNew = blob.includes(t.expectSubstring);
    const suppressesOld = !blob.includes(t.forbidSubstring);
    if (returnsNew && suppressesOld) temporalPass++;
    tmem.close();
    rmSync(troot, { recursive: true });
  }
  const temporalAcc = temporalPass / TEMPORAL.length;

  return {
    phase: "quality",
    config: disableVectors ? "bm25+graph" : "bm25+vector+graph",
    metrics: {
      recallAtK, mrr, temporalAcc,
      hits, totalRelevant, temporalPass, temporalTotal: TEMPORAL.length,
    },
  };
}

// ── Phase 2: Latency ─────────────────────────────────────────────────────

async function phaseLatency(memory: MemoryStore, disableVectors: boolean): Promise<PhaseResult> {
  const metrics: Record<string, string | number> = {};

  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    await memory.remember(AGENT, "fact", `warmup memory ${i}`, { tags: ["warmup"] });
    await memory.searchMemories({ query: "warmup", limit: 5 });
  }

  // remember latency
  const rememberTimes: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = process.hrtime.bigint();
    await memory.remember(AGENT, "fact", `latency test memory ${i} about TypeScript and Node`, { tags: ["latency", "typescript", "node"] });
    rememberTimes.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  metrics.rememberAvg = `${avg(rememberTimes).toFixed(1)}ms`;
  metrics.rememberMin = `${Math.min(...rememberTimes).toFixed(1)}ms`;
  metrics.rememberMax = `${Math.max(...rememberTimes).toFixed(1)}ms`;

  // search latency (cold — new query each time)
  const searchTimes: number[] = [];
  const queries = ["Node TypeScript", "database caching", "deploy AWS", "authentication JWT", "logging monitoring"];
  for (let i = 0; i < ITERATIONS; i++) {
    const q = queries[i % queries.length];
    const start = process.hrtime.bigint();
    await memory.searchMemories({ query: q, limit: K });
    searchTimes.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  metrics.searchAvg = `${avg(searchTimes).toFixed(1)}ms`;
  metrics.searchMin = `${Math.min(...searchTimes).toFixed(1)}ms`;
  metrics.searchMax = `${Math.max(...searchTimes).toFixed(1)}ms`;

  // forget latency
  const forgetIds = (await memory.listMemories({ type: "fact", limit: ITERATIONS })).map((e) => ({ id: e.id, type: e.type }));
  const forgetTimes: number[] = [];
  for (const { id, type } of forgetIds) {
    const start = process.hrtime.bigint();
    await memory.forget(id, type);
    forgetTimes.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  metrics.forgetAvg = forgetTimes.length ? `${avg(forgetTimes).toFixed(1)}ms` : "0ms";

  // consolidate latency
  const conStart = process.hrtime.bigint();
  await memory.consolidate();
  metrics.consolidate = `${(Number(process.hrtime.bigint() - conStart) / 1e6).toFixed(1)}ms`;

  return {
    phase: "latency",
    config: disableVectors ? "bm25+graph" : "bm25+vector+graph",
    metrics,
  };
}

// ── Phase 3: Scale ───────────────────────────────────────────────────────

async function phaseScale(disableVectors: boolean): Promise<PhaseResult[]> {
  const results: PhaseResult[] = [];

  for (const sp of SCALE_POINTS) {
    const root = `${ROOT}-scale-${sp.count}`;
    if (existsSync(root)) rmSync(root, { recursive: true });
    const memory = new MemoryStore(root, !disableVectors);

    const memories = generateScaleMemories(sp.count);
    const writeTimes: number[] = [];
    for (const m of memories) {
      const start = process.hrtime.bigint();
      await memory.remember(m.agent, m.type as any, m.content, {
        tags: m.tags, confidence: m.confidence, sourceTrust: m.sourceTrust,
      });
      writeTimes.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    // Give vectors time
    if (!disableVectors) await new Promise((r) => setTimeout(r, Math.min(2000, sp.count * 2)));

    // recall@{K} on the scale corpus
    const searchResults = await memory.searchMemories({ query: "TypeScript Node Express", limit: K });
    const recallAtK = searchResults.length > 0 ? searchResults.filter((r) => r.score > 0.1).length / K : 0;
    const mrr = searchResults.length > 0 ? 1 / (searchResults.findIndex((r) => r.score > 0.1) + 1) : 0;

    // search latency at this scale
    const sTimes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const q = ["database", "deploy", "auth", "monitoring", "cache"][i];
      const start = process.hrtime.bigint();
      await memory.searchMemories({ query: q, limit: K });
      sTimes.push(Number(process.hrtime.bigint() - start) / 1e6);
    }

    // Measure storage
    const disk = await measureDiskUsage(root);

    // Graph stats
    const graph = await memory.graphStats();

    memory.close();
    rmSync(root, { recursive: true });

    results.push({
      phase: `scale@${sp.label}`,
      config: disableVectors ? "bm25+graph" : "bm25+vector+graph",
      metrics: {
        count: sp.count,
        writeAvg: `${avg(writeTimes).toFixed(1)}ms`,
        writeThroughput: `${(sp.count / (writeTimes.reduce((a, b) => a + b, 0) / 1000)).toFixed(0)} mem/s`,
        searchAvg: `${avg(sTimes).toFixed(1)}ms`,
        recallAtK: +recallAtK.toFixed(3),
        mrr: +mrr.toFixed(3),
        storage: fmtBytes(disk.total),
        entities: graph.entityCount,
        edges: graph.edgeCount,
      },
    });
  }

  return results;
}

// ── Phase 4: Config comparison ───────────────────────────────────────────

async function phaseCompare(): Promise<PhaseResult[]> {
  const results: PhaseResult[] = [];
  const configs = [
    { vectors: false, graph: "json",  label: "bm25+graph (json)" },
    { vectors: false, graph: "sqlite", label: "bm25+graph (sqlite)" },
    { vectors: true,  graph: "json",  label: "bm25+vector+graph" },
  ];
  const mems = generateScaleMemories(100);

  for (const cfg of configs) {
    const root = `${ROOT}-cmp-${cfg.label.replace(/[^a-z0-9]/g, "-")}`;
    if (existsSync(root)) rmSync(root, { recursive: true });
    const memory = new MemoryStore(root, cfg.vectors, { graph: cfg.graph as any });

    const writeTimes: number[] = [];
    for (const m of mems) {
      const start = process.hrtime.bigint();
      await memory.remember(m.agent, m.type as any, m.content, {
        tags: m.tags, confidence: m.confidence, sourceTrust: m.sourceTrust,
      });
      writeTimes.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    if (cfg.vectors) await new Promise((r) => setTimeout(r, 1000));

    const searchResults = await memory.searchMemories({ query: "TypeScript database", limit: K });
    const sTimes: number[] = [];
    for (const q of ["TypeScript", "database", "deploy", "auth", "Redis"]) {
      const start = process.hrtime.bigint();
      await memory.searchMemories({ query: q, limit: K });
      sTimes.push(Number(process.hrtime.bigint() - start) / 1e6);
    }

    const disk = await measureDiskUsage(root);
    const graph = await memory.graphStats();

    memory.close();
    rmSync(root, { recursive: true });

    results.push({
      phase: "compare",
      config: cfg.label,
      metrics: {
        writeAvg: `${avg(writeTimes).toFixed(1)}ms`,
        searchAvg: `${avg(sTimes).toFixed(1)}ms`,
        recallTop: +(searchResults.filter((r) => r.score > 0.1).length / K).toFixed(3),
        storage: fmtBytes(disk.total),
        entities: graph.entityCount,
        edges: graph.edgeCount,
      },
    });
  }

  return results;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const quick = args.includes("--quick");
  const doCompare = args.includes("--compare");
  const disableVectors = process.env.ORACLE_MEMORY_DISABLE_VECTORS === "1";

  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true });

  const allResults: PhaseResult[] = [];
  const startWall = Date.now();

  // ── Phase 1: Quality ────────────────────────────────────────────
  console.log("\n── Phase 1: Retrieval Quality ──────────────────────────");
  const qMem = new MemoryStore(ROOT, !disableVectors);
  const q = await phaseQuality(qMem, disableVectors);
  allResults.push(q);
  console.log(`  recall@${K}: ${pct(+(q.metrics.recallAtK as number))}  MRR: ${(q.metrics.mrr as number).toFixed(3)}  temporal: ${pct(+(q.metrics.temporalAcc as number))}`);
  qMem.close();

  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true });

  // ── Phase 2: Latency ────────────────────────────────────────────
  console.log("\n── Phase 2: Operation Latency ──────────────────────────");
  const lMem = new MemoryStore(ROOT, !disableVectors);
  const l = await phaseLatency(lMem, disableVectors);
  allResults.push(l);
  console.log(`  remember: ${l.metrics.rememberAvg}  search: ${l.metrics.searchAvg}  forget: ${l.metrics.forgetAvg}  consolidate: ${l.metrics.consolidate}`);
  lMem.close();

  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true });

  // ── Phase 3: Scale ──────────────────────────────────────────────
  if (!quick) {
    console.log("\n── Phase 3: Scale Stress ──────────────────────────────");
    const scaleResults = await phaseScale(disableVectors);
    for (const r of scaleResults) {
      allResults.push(r);
      console.log(`  ${r.phase}: write=${r.metrics.writeAvg}  search=${r.metrics.searchAvg}  storage=${r.metrics.storage}  entities=${r.metrics.entities}`);
    }
  }

  // ── Phase 4: Config Comparison (--compare) ──────────────────────
  if (doCompare) {
    console.log("\n── Phase 4: Config Comparison ─────────────────────────");
    const cmpResults = await phaseCompare();
    for (const r of cmpResults) {
      allResults.push(r);
      console.log(`  ${r.config}: write=${r.metrics.writeAvg}  search=${r.metrics.searchAvg}  storage=${r.metrics.storage}`);
    }
  }

  // ── Report ──────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startWall) / 1000).toFixed(1);
  console.log("\n──────── oracle-memory bench ────────");
  console.log(`vectors:            ${disableVectors ? "off" : "on"}`);
  console.log(`llm detectors:      ${process.env.ORACLE_MEMORY_LLM_GRAPH === "1" && process.env.ANTHROPIC_API_KEY ? "on" : "off"}`);
  console.log(`compare mode:       ${doCompare ? "on" : "off"}`);
  console.log(`elapsed:            ${elapsed}s`);
  console.log("─────────────────────────────────────");

  // ── SVG Report ──────────────────────────────────────────────────
  const svg = renderBenchSvg(allResults, {
    vectors: disableVectors ? "off" : "on",
    llm: process.env.ORACLE_MEMORY_LLM_GRAPH === "1" && process.env.ANTHROPIC_API_KEY ? "on" : "off",
    elapsed: `${elapsed}s`,
  });
  const outPath = path.join(DIRNAME, "results.svg");
  writeFileSync(outPath, svg, "utf-8");
  console.log(`SVG report → ${outPath}`);

  // Non-zero exit if quality regresses below a floor
  const qRecall = q.metrics.recallAtK as number;
  const qTemporal = q.metrics.temporalAcc as number;
  const FLOOR_RECALL = 0.75;
  const FLOOR_TEMPORAL = 1.0;
  if (qRecall < FLOOR_RECALL || qTemporal < FLOOR_TEMPORAL) {
    console.error(`\nFAIL: below floor (recall@${K} ≥ ${pct(FLOOR_RECALL)}, temporal ≥ ${pct(FLOOR_TEMPORAL)})`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("bench error:", e);
  process.exit(1);
});
