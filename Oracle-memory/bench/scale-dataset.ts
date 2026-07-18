/**
 * Large-scale synthetic datasets for oracle-memory benchmarks.
 *
 * Generates N memories with realistic distribution: facts (40%), insights (30%),
 * chunks (20%), working (10%). Topics drawn from a pool of ~50 entities so the
 * entity graph and vector store have non-trivial work to do.
 *
 * Deterministic — same count + seed produces identical output.
 */

export interface ScalePoint {
  label: string;
  count: number;
}

export const SCALE_POINTS: ScalePoint[] = [
  { label: "50",   count: 50 },
  { label: "100",  count: 100 },
  { label: "200",  count: 200 },
];

const ENTITIES = [
  "TypeScript", "React", "Node", "PostgreSQL", "Redis", "Docker",
  "Kubernetes", "AWS", "GitHub", "ESLint", "Prettier", "Vitest",
  "JWT", "OAuth", "GraphQL", "REST", "WebSocket", "MCP",
  "Linux", "Bash", "Python", "Go", "Rust", "Express",
  "Fastify", "Prisma", "tRPC", "Zod", "Biome", "OpenAI",
  "Anthropic", "MongoDB", "SQLite", "Nginx", "Datadog",
  "Sentry", "Terraform", "Ansible", "Prometheus", "Grafana",
  "Kafka", "RabbitMQ", "Elasticsearch", "MinIO", "Vite",
  "Next.js", "Tailwind", "shadcn/ui", "Playwright", "Cypress",
];

const ACTIONS = [
  "uses", "fronts", "migrated to", "depends on", "implements",
  "is configured with", "replaced by", "backs", "monitors",
  "deploys via", "authenticates with", "caches via",
];

const TAGS_POOL = [
  ["frontend", "ui"], ["backend", "api"], ["database", "storage"],
  ["devops", "infra"], ["testing", "qa"], ["security", "auth"],
  ["tooling", "config"], ["performance", "scaling"],
  ["observability", "monitoring"], ["ci/cd", "deploy"],
  ["networking", "protocol"], ["architecture", "design"],
  ["data", "analytics"], ["logging", "debugging"],
  ["ai", "ml"], ["mobile", "web"],
];

const TYPES = ["fact", "fact", "fact", "fact", "insight", "insight", "insight", "chunk", "chunk", "working"] as const;

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export interface ScaleMemory {
  agent: string;
  type: string;
  content: string;
  tags: string[];
  confidence: number;
  sourceTrust: number;
}

/**
 * Generate `count` synthetic memories. Deterministic for a given seed.
 */
export function generateScaleMemories(count: number, seed = 42): ScaleMemory[] {
  const rng = mulberry32(seed);
  const memories: ScaleMemory[] = [];
  const agents = ["alice", "bob", "charlie", "diana", "echo"];

  for (let i = 0; i < count; i++) {
    const type = TYPES[Math.floor(rng() * TYPES.length)];
    const entity1 = ENTITIES[Math.floor(rng() * ENTITIES.length)];
    let entity2: string;
    do { entity2 = ENTITIES[Math.floor(rng() * ENTITIES.length)]; } while (entity2 === entity1);
    const action = ACTIONS[Math.floor(rng() * ACTIONS.length)];
    const tagSet = TAGS_POOL[Math.floor(rng() * TAGS_POOL.length)];
    const agent = agents[Math.floor(rng() * agents.length)];

    let content: string;
    switch (type) {
      case "fact":
        content = `${entity1} ${action} ${entity2} in ${type === "fact" ? "production" : "staging"} at ${["acme", "globex", "initech", "umbrella", "cyberdyne"][Math.floor(rng() * 5)]}.`;
        break;
      case "insight":
        content = `Learned that ${entity1} and ${entity2} integration needs careful timeout tuning — we saw ${Math.floor(rng() * 30 + 5)}s p99 latency before adjusting.`;
        break;
      case "chunk":
        content = `Session note: discussed migrating from ${entity1} to ${entity2}. Key decision: ${rng() > 0.5 ? "proceed" : "defer"} after ${["Q3", "Q4", "next release", "the audit"][Math.floor(rng() * 4)]}.`;
        break;
      default:
        content = `TODO: investigate ${entity1} ${action} ${entity2} ${entity1.toLowerCase()} options.`;
    }

    memories.push({
      agent,
      type,
      content,
      tags: [...tagSet, entity1.toLowerCase(), entity2.toLowerCase()].slice(0, 6),
      confidence: +(0.5 + rng() * 0.5).toFixed(2),
      sourceTrust: +(0.3 + rng() * 0.7).toFixed(2),
    });
  }

  return memories;
}
