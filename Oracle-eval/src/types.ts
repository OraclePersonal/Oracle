/**
 * Shared types for oracle-eval.
 */

/** Result from a single benchmark phase */
export interface PhaseResult {
  phase: string;
  config: string;
  metrics: Record<string, string | number>;
}

/** Metadata for the SVG report header */
export interface BenchMeta {
  target: string;
  version: string;
  elapsed?: string;
  timestamp?: string;
}

/** Evaluation scenario descriptor */
export interface EvalScenario {
  name: string;
  description: string;
  category: "memory" | "messages" | "orchestration";
}

/** Quality metrics for memory retrieval */
export interface MemoryQualityMetrics {
  recallAtK: number;
  mrr: number;
  temporalAcc: number;
  totalHits: number;
  totalRelevant: number;
  temporalPass: number;
  temporalTotal: number;
}

/** Throughput metrics for messages */
export interface MessagesThroughputMetrics {
  sendAvg: string;
  sendMin: string;
  sendMax: string;
  pollAvg: string;
  pollMin: string;
  pollMax: string;
  totalOps: number;
  errors: number;
}

/** Orchestration metrics */
export interface OrchestrationMetrics {
  roundtripAvg: string;
  roundtripMin: string;
  roundtripMax: string;
  toolCalls: number;
  errors: number;
}
