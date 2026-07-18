/**
 * oracle-memory benchmark evaluator.
 *
 * Tests retrieval quality:
 *   - recall@k: fraction of ground-truth relevant results in top-k
 *   - MRR: Mean Reciprocal Rank across queries
 *   - Temporal accuracy: newer info displaces older info in results
 *
 * Designed to work against a running oracle-memory MCP server via HTTP,
 * or directly against the MemoryStore when imported in bench mode.
 */

import type { PhaseResult } from "../types.js";

export interface MemoryEvalOptions {
  endpoint: string;
  k: number;
  quick: boolean;
}

// ── Seed data: synthetic memories for recall/ranking tests ────────────────

export interface SeedMemory {
  key: string;
  agent: string;
  type: string;
  content: string;
  tags: string[];
  confidence: number;
  sourceTrust: number;
}

const SEED: SeedMemory[] = [
  { key: "ts-config", agent: "eval", type: "fact", content: "TypeScript strict mode requires 'strict: true' in tsconfig.json with NodeNext module resolution", tags: ["typescript", "config"], confidence: 1, sourceTrust: 1 },
  { key: "node-runtime", agent: "eval", type: "fact", content: "Node 24+ supports native TypeScript via --experimental-strip-types", tags: ["node", "typescript"], confidence: 0.9, sourceTrust: 0.8 },
  { key: "mcp-sdk", agent: "eval", type: "fact", content: "@modelcontextprotocol/sdk provides Server, StdioServerTransport, and tool schemas", tags: ["mcp", "sdk", "typescript"], confidence: 1, sourceTrust: 1 },
  { key: "esm-module", agent: "eval", type: "fact", content: "ESM modules use 'type': 'module' in package.json and .js extensions in relative imports", tags: ["esm", "module", "typescript"], confidence: 1, sourceTrust: 1 },
  { key: "vector-store", agent: "eval", type: "insight", content: "Vector search quality degrades when embeddings are too sparse — use at least 100 memories for useful recall", tags: ["vectors", "search", "quality"], confidence: 0.85, sourceTrust: 0.7 },
  { key: "graph-store", agent: "eval", type: "fact", content: "Entity graph stores relationships between tagged concepts for associative retrieval", tags: ["graph", "entity", "retrieval"], confidence: 0.95, sourceTrust: 0.9 },
  { key: "bm25-search", agent: "eval", type: "fact", content: "BM25 is a bag-of-words ranking function that scores documents by term frequency and inverse document frequency", tags: ["search", "bm25", "ranking"], confidence: 1, sourceTrust: 1 },
  { key: "recall-metric", agent: "eval", type: "insight", content: "recall@k measures the fraction of relevant documents retrieved in the top k results", tags: ["eval", "recall", "metric"], confidence: 0.9, sourceTrust: 0.8 },
  { key: "mrr-metric", agent: "eval", type: "insight", content: "Mean Reciprocal Rank averages the reciprocal rank of the first relevant result across queries", tags: ["eval", "mrr", "metric"], confidence: 0.9, sourceTrust: 0.8 },
  { key: "temporal-correctness", agent: "eval", type: "insight", content: "Temporal correctness measures whether the most recent relevant information appears before outdated information", tags: ["eval", "temporal", "correctness"], confidence: 0.85, sourceTrust: 0.75 },
  { key: "jwt-auth", agent: "eval", type: "fact", content: "JWT tokens should be verified server-side with a secret or public key, never trusted from the client", tags: ["auth", "jwt", "security"], confidence: 1, sourceTrust: 1 },
  { key: "redis-cache", agent: "eval", type: "fact", content: "Redis is an in-memory data store commonly used for caching, session management, and pub/sub messaging", tags: ["redis", "cache", "database"], confidence: 1, sourceTrust: 1 },
  { key: "docker-deploy", agent: "eval", type: "fact", content: "Docker multi-stage builds reduce final image size by separating build dependencies from runtime", tags: ["docker", "deploy", "devops"], confidence: 0.95, sourceTrust: 0.9 },
  { key: "ci-pipeline", agent: "eval", type: "fact", content: "CI pipelines should run type checking, linting, and tests before deployment", tags: ["ci", "pipeline", "testing"], confidence: 1, sourceTrust: 1 },
  { key: "observability", agent: "eval", type: "insight", content: "Structured logging with correlation IDs makes debugging distributed systems tractable", tags: ["logging", "observability", "debugging"], confidence: 0.9, sourceTrust: 0.85 },
];

// ── Retrieval queries with ground-truth relevance ─────────────────────────

export interface RetrievalQuery {
  query: string;
  relevant: string[]; // keys of relevant seed memories
}

const RETRIEVAL: RetrievalQuery[] = [
  { query: "TypeScript configuration tsconfig strict", relevant: ["ts-config", "esm-module"] },
  { query: "MCP server SDK setup", relevant: ["mcp-sdk", "esm-module"] },
  { query: "search ranking BM25 vector", relevant: ["bm25-search", "vector-store", "recall-metric"] },
  { query: "evaluation metrics recall MRR", relevant: ["recall-metric", "mrr-metric"] },
  { query: "authentication JWT tokens security", relevant: ["jwt-auth"] },
  { query: "caching Redis performance", relevant: ["redis-cache"] },
  { query: "Docker deploy CI pipeline", relevant: ["docker-deploy", "ci-pipeline"] },
  { query: "graph entity retrieval relationships", relevant: ["graph-store", "vector-store"] },
];

// ── Temporal correctness test data ────────────────────────────────────────

export interface TemporalQuery {
  originalKey: string;
  updateKey: string;
  query: string;
  expectSubstring: string;
  forbidSubstring: string;
}

interface TemporalMemory {
  agent: string;
  type: string;
  content: string;
  tags: string[];
  confidence: number;
  sourceTrust: number;
}

const TEMPORAL_MEMORIES: Record<string, TemporalMemory> = {
  old_api: {
    agent: "eval", type: "fact", confidence: 1, sourceTrust: 1,
    content: "The legacy API endpoint /api/v1/query returns XML responses",
    tags: ["api", "legacy"],
  },
  new_api: {
    agent: "eval", type: "fact", confidence: 1, sourceTrust: 1,
    content: "The current API endpoint /api/v2/search returns JSON responses with pagination",
    tags: ["api", "current"],
  },
  old_config: {
    agent: "eval", type: "fact", confidence: 1, sourceTrust: 1,
    content: "Default timeout was 30 seconds for all outgoing HTTP requests",
    tags: ["config", "timeout"],
  },
  new_config: {
    agent: "eval", type: "fact", confidence: 1, sourceTrust: 1,
    content: "Default timeout is 10 seconds for outgoing HTTP requests with retry strategy",
    tags: ["config", "timeout"],
  },
};

const TEMPORAL: TemporalQuery[] = [
  {
    originalKey: "old_api",
    updateKey: "new_api",
    query: "API endpoint response format",
    expectSubstring: "/api/v2/search",
    forbidSubstring: "/api/v1/query",
  },
  {
    originalKey: "old_config",
    updateKey: "new_config",
    query: "HTTP request timeout configuration",
    expectSubstring: "10 seconds",
    forbidSubstring: "30 seconds",
  },
];

// ── HTTP client helpers for MCP tool calls ────────────────────────────────

async function mcpCall(endpoint: string, tool: string, args: Record<string, unknown>): Promise<any> {
  const url = endpoint.replace(/\/+$/, "");
  const response = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  if (!response.ok) {
    throw new Error(`MCP call failed (${response.status}): ${await response.text()}`);
  }
  const data = await response.json();
  if (data.error) throw new Error(`MCP error: ${data.error.message}`);
  return data;
}

async function mcpListTools(endpoint: string): Promise<string[]> {
  const url = endpoint.replace(/\/+$/, "");
  const response = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
  if (!response.ok) return [];
  const data: any = await response.json();
  return (data.result?.tools ?? []).map((t: any) => t.name);
}

// ── Main Evaluator ────────────────────────────────────────────────────────

/**
 * Run memory retrieval quality benchmarks against a live oracle-memory server.
 */
export async function runMemoryEval(opts: MemoryEvalOptions): Promise<PhaseResult> {
  const { endpoint, k } = opts;

  // Check connectivity
  const tools = await mcpListTools(endpoint);
  console.error(`[oracle-eval] memory endpoint tools: ${tools.join(", ")}`);

  // Phase 1: Seed memories
  console.error(`[oracle-eval] seeding ${SEED.length} memories...`);
  const keyToId = new Map<string, string>();

  for (const m of SEED) {
    const result = await mcpCall(endpoint, "remember", {
      agent: m.agent,
      type: m.type,
      content: m.content,
      tags: m.tags,
      confidence: m.confidence,
      sourceTrust: m.sourceTrust,
    });
    const id = result.result?.id ?? result.result?.entry?.id;
    if (id) keyToId.set(m.key, id);
  }

  // Give vector index time to process
  await new Promise((r) => setTimeout(r, 1500));

  // Phase 2: Recall@k and MRR
  console.error(`[oracle-eval] measuring recall@${k} and MRR...`);
  let hits = 0;
  let totalRelevant = 0;
  let mrrSum = 0;

  for (const c of RETRIEVAL) {
    const result = await mcpCall(endpoint, "search_memories", {
      query: c.query,
      limit: k,
    });
    const results: Array<{ id: string; score: number }> = result.result?.results ?? result.result ?? [];
    const gotIds = results.map((r: any) => r.id ?? r.entry?.id).filter(Boolean);
    const relevantIds = c.relevant.map((rk) => keyToId.get(rk)).filter(Boolean) as string[];

    totalRelevant += relevantIds.length;
    for (const rid of relevantIds) {
      if (gotIds.includes(rid)) hits++;
    }

    const firstRank = gotIds.findIndex((id: string) => relevantIds.includes(id));
    if (firstRank >= 0) mrrSum += 1 / (firstRank + 1);
  }

  const recallAtK = totalRelevant > 0 ? hits / totalRelevant : 0;
  const mrr = RETRIEVAL.length > 0 ? mrrSum / RETRIEVAL.length : 0;

  // Phase 3: Temporal correctness
  console.error(`[oracle-eval] measuring temporal correctness...`);
  let temporalPass = 0;

  for (const t of TEMPORAL) {
    const orig = TEMPORAL_MEMORIES[t.originalKey];
    const upd = TEMPORAL_MEMORIES[t.updateKey];

    await mcpCall(endpoint, "remember", {
      agent: orig.agent, type: orig.type, content: orig.content,
      tags: orig.tags, confidence: orig.confidence, sourceTrust: orig.sourceTrust,
    });
    await mcpCall(endpoint, "remember", {
      agent: upd.agent, type: upd.type, content: upd.content,
      tags: upd.tags, confidence: upd.confidence, sourceTrust: upd.sourceTrust,
    });

    await new Promise((r) => setTimeout(r, 800));

    const result = await mcpCall(endpoint, "search_memories", {
      query: t.query, limit: k,
    });
    const results: Array<{ content: string }> = result.result?.results ?? result.result ?? [];
    const blob = results.map((r: any) => r.content ?? r.entry?.content ?? "").join(" \n ");

    const returnsNew = blob.includes(t.expectSubstring);
    const suppressesOld = !blob.includes(t.forbidSubstring);
    if (returnsNew && suppressesOld) temporalPass++;
  }

  const temporalAcc = TEMPORAL.length > 0 ? temporalPass / TEMPORAL.length : 0;

  return {
    phase: "memory_quality",
    config: `recall@${k}`,
    metrics: {
      recallAtK: +recallAtK.toFixed(4),
      mrr: +mrr.toFixed(4),
      temporalAcc: +temporalAcc.toFixed(4),
      hits,
      totalRelevant,
      temporalPass,
      temporalTotal: TEMPORAL.length,
    },
  };
}

/**
 * Run a self-contained memory eval (quality only) with a local MemoryStore.
 * Imported in bench mode for direct usage (no HTTP needed).
 */
export async function runLocalMemoryEval(
  MemoryStoreCtor: new (rootDir: string, enableVectors: boolean) => { remember: Function; searchMemories: Function; close: Function },
  rootDir: string,
  enableVectors: boolean,
): Promise<PhaseResult> {
  const store = new MemoryStoreCtor(rootDir, enableVectors);
  const keyToId = new Map<string, string>();

  // Seed
  for (const m of SEED) {
    const result = await (store.remember as any)(m.agent, m.type, m.content, {
      tags: m.tags,
      confidence: m.confidence,
      sourceTrust: m.sourceTrust,
    });
    keyToId.set(m.key, result.id);
  }

  if (enableVectors) await new Promise((r) => setTimeout(r, 1500));

  // Recall@k and MRR
  const k = 5;
  let hits = 0;
  let totalRelevant = 0;
  let mrrSum = 0;

  for (const c of RETRIEVAL) {
    const results = await (store.searchMemories as any)({ query: c.query, limit: k });
    const gotIds = results.map((r: any) => r.entry.id);
    const relevantIds = c.relevant.map((rk) => keyToId.get(rk)!).filter(Boolean);
    totalRelevant += relevantIds.length;
    for (const rid of relevantIds) if (gotIds.includes(rid)) hits++;
    const firstRank = gotIds.findIndex((id: string) => relevantIds.includes(id));
    if (firstRank >= 0) mrrSum += 1 / (firstRank + 1);
  }

  const recallAtK = totalRelevant > 0 ? hits / totalRelevant : 0;
  const mrr = RETRIEVAL.length > 0 ? mrrSum / RETRIEVAL.length : 0;

  // Temporal
  let temporalPass = 0;
  for (const t of TEMPORAL) {
    const orig = TEMPORAL_MEMORIES[t.originalKey];
    const upd = TEMPORAL_MEMORIES[t.updateKey];
    await (store.remember as any)(orig.agent, orig.type, orig.content, { tags: orig.tags, confidence: orig.confidence, sourceTrust: orig.sourceTrust });
    await (store.remember as any)(upd.agent, upd.type, upd.content, { tags: upd.tags, confidence: upd.confidence, sourceTrust: upd.sourceTrust });
    if (enableVectors) await new Promise((r) => setTimeout(r, 800));
    const results = await (store.searchMemories as any)({ query: t.query, limit: k });
    const blob = results.map((r: any) => r.entry.content).join(" \n ");
    if (blob.includes(t.expectSubstring) && !blob.includes(t.forbidSubstring)) temporalPass++;
  }

  store.close();

  return {
    phase: "memory_quality",
    config: `recall@${k}`,
    metrics: {
      recallAtK: +recallAtK.toFixed(4),
      mrr: +mrr.toFixed(4),
      temporalAcc: +(temporalPass / TEMPORAL.length).toFixed(4),
      hits,
      totalRelevant,
      temporalPass,
      temporalTotal: TEMPORAL.length,
    },
  };
}

export { SEED, RETRIEVAL, TEMPORAL, TEMPORAL_MEMORIES };
