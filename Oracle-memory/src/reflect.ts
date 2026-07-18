/**
 * Reflective insight synthesis.
 *
 * `consolidator.ts` merges near-duplicate memories by concatenating their
 * text — lossless but not *generative*. Reflection is the opposite: take a
 * cluster of related memories and ask an LLM to distill a NEW, higher-level
 * insight that none of them stated outright ("three separate notes about slow
 * queries → the real lesson is: index before you optimize app code").
 *
 * This is the Letta/reflective-agent pattern. It is strictly opt-in and
 * requires an API key; `createReflector` returns null otherwise so callers can
 * wire it unconditionally and simply skip reflection when unavailable.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { MemoryEntry } from "./types.js";

const MODEL = "claude-opus-4-8";

const REFLECTION_SCHEMA = {
  type: "object",
  properties: {
    insights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          content: { type: "string", description: "The synthesized insight, one or two sentences, standalone." },
          tags: { type: "array", items: { type: "string" }, description: "Lowercase topical tags." },
          confidence: { type: "number", description: "0-1 how well-supported this insight is by the source memories." },
          sourceIds: { type: "array", items: { type: "string" }, description: "IDs of the memories this insight draws from." },
        },
        required: ["content", "tags", "confidence", "sourceIds"],
        additionalProperties: false,
      },
    },
  },
  required: ["insights"],
  additionalProperties: false,
} as const;

const SYSTEM = `You are the reflective memory of an AI coding agent.
Given a cluster of related memories, synthesize higher-level INSIGHTS that are
not stated verbatim in any single memory but emerge from the pattern across
them. Rules:
- Each insight must be genuinely new synthesis, not a restatement or summary.
- Prefer actionable lessons, causal links, and generalizations.
- Be conservative: if the memories don't support a real generalization, return
  fewer insights (or none). Do not invent facts.
- Cite the memory ids each insight draws from.`;

export interface Reflection {
  content: string;
  tags: string[];
  confidence: number;
  sourceIds: string[];
}

export type Reflector = (memories: MemoryEntry[]) => Promise<Reflection[]>;

export interface ReflectorOptions {
  apiKey?: string;
  model?: string;
  /** Cap memories sent per reflection call (token guard). */
  maxMemories?: number;
  /** Only emit insights at/above this confidence. Default 0.5. */
  minConfidence?: number;
}

export function createReflector(opts: ReflectorOptions = {}): Reflector | null {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const client = new Anthropic({ apiKey });
  const model = opts.model ?? MODEL;
  const maxMemories = opts.maxMemories ?? 40;
  const minConfidence = opts.minConfidence ?? 0.5;

  return async (memories) => {
    const usable = memories.filter((m) => !m.archived && !m.pruned && !m.validTo && !m.quarantined).slice(0, maxMemories);
    if (usable.length < 2) return [];

    const list = usable
      .map((m) => `- id=${m.id} [${m.type}]${m.tags.length ? ` (${m.tags.join(", ")})` : ""}: ${m.content.replace(/\s+/g, " ").slice(0, 600)}`)
      .join("\n");

    let response;
    try {
      response = await client.messages.create({
        model,
        max_tokens: 2048,
        system: SYSTEM,
        output_config: { format: { type: "json_schema", schema: REFLECTION_SCHEMA } },
        messages: [{ role: "user", content: `Memories:\n${list}` }],
      });
    } catch {
      return [];
    }

    if (response.stop_reason === "refusal") return [];
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return [];

    let parsed: { insights?: Reflection[] };
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      return [];
    }

    const insights = Array.isArray(parsed.insights) ? parsed.insights : [];
    return insights
      .filter((i) => i && typeof i.content === "string" && i.content.trim().length > 0)
      .filter((i) => (typeof i.confidence === "number" ? i.confidence : 0) >= minConfidence)
      .map((i) => ({
        content: i.content.trim(),
        tags: Array.isArray(i.tags) ? i.tags.map((t) => String(t).toLowerCase()) : [],
        confidence: typeof i.confidence === "number" ? i.confidence : minConfidence,
        sourceIds: Array.isArray(i.sourceIds) ? i.sourceIds : [],
      }));
  };
}

/**
 * Group memories into topical clusters by tag overlap (transitive) so
 * reflection runs on coherent sets instead of the whole store at once.
 * Pure heuristic — no LLM. Singletons are dropped (nothing to synthesize).
 */
export function clusterByTags(memories: MemoryEntry[], minClusterSize = 2): MemoryEntry[][] {
  const usable = memories.filter((m) => !m.archived && !m.pruned && !m.validTo && !m.quarantined && m.tags.length > 0);
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (a: string, b: string) => { parent.set(find(a), find(b)); };

  for (const m of usable) parent.set(m.id, m.id);
  // Union memories that share at least one tag.
  const byTag = new Map<string, string[]>();
  for (const m of usable) {
    for (const t of m.tags.map((x) => x.toLowerCase())) {
      const arr = byTag.get(t) ?? [];
      arr.push(m.id);
      byTag.set(t, arr);
    }
  }
  for (const ids of byTag.values()) {
    for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
  }

  const groups = new Map<string, MemoryEntry[]>();
  for (const m of usable) {
    const root = find(m.id);
    const arr = groups.get(root) ?? [];
    arr.push(m);
    groups.set(root, arr);
  }
  return Array.from(groups.values()).filter((g) => g.length >= minClusterSize);
}
