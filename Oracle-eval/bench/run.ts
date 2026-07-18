#!/usr/bin/env node
/**
 * oracle-eval standalone benchmark runner.
 *
 * Runs benchmarks against the Oracle stack components and generates an SVG report.
 *
 * Usage:
 *   npm run bench                                    # full suite (memory + messages)
 *   npm run bench -- --quick                         # memory quality only
 *   npm run bench -- --memory http://localhost:8765   # custom memory endpoint
 *   npm run bench -- --messages http://localhost:8766 # custom messages endpoint
 *   npm run bench -- --output ./custom-report.svg    # custom output path
 *
 * Phases:
 *   1. Memory Quality — recall@k, MRR, temporal accuracy
 *   2. Messages Throughput — send latency, poll latency (requires oracle-messages)
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderBenchSvg } from "../src/report.js";
import type { PhaseResult } from "../src/types.js";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MEMORY_ENDPOINT = process.env.ORACLE_EVAL_MEMORY_ENDPOINT ?? "http://localhost:8765";
const DEFAULT_MESSAGES_ENDPOINT = process.env.ORACLE_EVAL_MESSAGES_ENDPOINT ?? "http://localhost:8766";
const OUTPUT_DIR = path.join(DIRNAME, "results");
const DEFAULT_OUTPUT = path.join(OUTPUT_DIR, "results.svg");

// ── Helpers ───────────────────────────────────────────────────────────────

function parseArgs(): {
  quick: boolean;
  memoryEndpoint: string;
  messagesEndpoint: string;
  output: string;
} {
  const args = process.argv.slice(2);
  const quick = args.includes("--quick");
  const memIdx = args.indexOf("--memory");
  const msgIdx = args.indexOf("--messages");
  const outIdx = args.indexOf("--output");

  return {
    quick,
    memoryEndpoint: memIdx >= 0 && args[memIdx + 1] ? args[memIdx + 1] : DEFAULT_MEMORY_ENDPOINT,
    messagesEndpoint: msgIdx >= 0 && args[msgIdx + 1] ? args[msgIdx + 1] : DEFAULT_MESSAGES_ENDPOINT,
    output: outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : DEFAULT_OUTPUT,
  };
}

function verifyEndpoint(url: string, label: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    console.error(`[oracle-eval] ${label}: invalid URL "${url}" — skipping`);
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { quick, memoryEndpoint, messagesEndpoint, output } = parseArgs();

  const allResults: PhaseResult[] = [];
  const startWall = Date.now();

  // Ensure output directory
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // ── Phase 1: Memory Quality ──────────────────────────────────────────────
  console.log("\n── Phase 1: Memory Retrieval Quality ──────────────────────");
  if (verifyEndpoint(memoryEndpoint, "memory")) {
    try {
      const { runMemoryEval } = await import("../src/eval/memory.js");
      const q = await runMemoryEval({ endpoint: memoryEndpoint, k: 5, quick });
      allResults.push(q);
      const recall = q.metrics.recallAtK as number;
      const mrr = q.metrics.mrr as number;
      const temporal = q.metrics.temporalAcc as number;
      console.log(`  recall@5:    ${(recall * 100).toFixed(1)}%`);
      console.log(`  MRR:         ${mrr.toFixed(3)}`);
      console.log(`  temporal:    ${(temporal * 100).toFixed(1)}%`);
    } catch (err) {
      console.error(`  [ERROR] memory eval failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`  Make sure oracle-memory is running at ${memoryEndpoint}`);
    }
  }

  // ── Phase 2: Messages Throughput ─────────────────────────────────────────
  if (!quick) {
    console.log("\n── Phase 2: Messages Throughput ──────────────────────────");
    if (verifyEndpoint(messagesEndpoint, "messages")) {
      try {
        const { runMessagesEval } = await import("../src/eval/messages.js");
        const m = await runMessagesEval({
          endpoint: messagesEndpoint,
          iterations: 50,
          payloadSize: 256,
        });
        allResults.push(m);
        console.log(`  send avg:    ${m.metrics.sendAvg}`);
        console.log(`  poll avg:    ${m.metrics.pollAvg}`);
        console.log(`  throughput:  ${m.metrics.throughput}`);
      } catch (err) {
        console.error(`  [ERROR] messages eval failed: ${err instanceof Error ? err.message : String(err)}`);
        console.error(`  Make sure oracle-messages is running at ${messagesEndpoint}`);
      }
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startWall) / 1000).toFixed(1);
  console.log("\n──────── oracle-eval bench ────────");
  console.log(`memory endpoint:    ${memoryEndpoint}`);
  console.log(`messages endpoint:  ${messagesEndpoint}`);
  console.log(`quick mode:         ${quick ? "on" : "off"}`);
  console.log(`elapsed:            ${elapsed}s`);
  console.log(`phases completed:   ${allResults.length}`);
  console.log("─────────────────────────────────────");

  // ── SVG Report ──────────────────────────────────────────────────────────
  if (allResults.length > 0) {
    const svg = renderBenchSvg(allResults, {
      target: "Oracle Ecosystem",
      version: "0.1.0",
      elapsed: `${elapsed}s`,
      timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
    });
    writeFileSync(output, svg, "utf-8");
    console.log(`\nSVG report → ${output}`);
  } else {
    console.log("\nNo benchmarks completed — no SVG report generated.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("bench error:", e);
  process.exit(1);
});
