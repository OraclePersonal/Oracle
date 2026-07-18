/**
 * LLM-backed triple extractor for the knowledge graph.
 *
 * Produces a `TripleExtractor` (see entity.ts) that asks Claude to pull typed
 * (subject, relation, object) triples out of memory content — including the
 * lowercase domain concepts ("caching", "latency", "auth") that the heuristic
 * capitalization/keyword extractor cannot see. Purely additive: if no API key
 * is configured, `createLlmExtractor` returns null and the graph falls back to
 * heuristics only.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { EntityType, ExtractedTriple, TripleExtractor } from "./entity.js";

const MODEL = "claude-opus-4-8";

const ENTITY_TYPES: EntityType[] = ["person", "technology", "project", "concept", "tool"];

/** JSON schema constraining Claude's output to a list of typed triples. */
const TRIPLE_SCHEMA = {
  type: "object",
  properties: {
    triples: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: { type: "string", description: "Subject entity, canonical name" },
          fromType: { type: "string", enum: ENTITY_TYPES },
          relation: { type: "string", description: "Relation verb, e.g. uses, implements, depends_on, fronts, migrates, related_to" },
          to: { type: "string", description: "Object entity, canonical name" },
          toType: { type: "string", enum: ENTITY_TYPES },
        },
        required: ["from", "fromType", "relation", "to", "toType"],
        additionalProperties: false,
      },
    },
  },
  required: ["triples"],
  additionalProperties: false,
} as const;

const SYSTEM = `You extract a knowledge graph from a short memory note written by/for an AI coding agent.
Return typed (subject, relation, object) triples that capture the meaningful relationships in the text.
- Include lowercase domain concepts (e.g. "caching", "latency", "authentication") as entities — not only proper nouns.
- Use concise, lowercase relation verbs: uses, implements, depends_on, fronts, migrates, calls, related_to, etc.
- Prefer canonical names (e.g. "PostgreSQL" not "postgres").
- Return an empty list if the note states no relationship.`;

export interface LlmExtractorOptions {
  /** Anthropic API key. Defaults to ANTHROPIC_API_KEY from the environment. */
  apiKey?: string;
  /** Override the model. Defaults to claude-opus-4-8. */
  model?: string;
  /** Max triples to keep per memory (guards against runaway output). */
  maxTriples?: number;
}

/**
 * Build an LLM triple extractor, or return null if no credentials are available
 * (so callers can wire it unconditionally: `graph.setExtractor(createLlmExtractor())`).
 */
export function createLlmExtractor(opts: LlmExtractorOptions = {}): TripleExtractor | null {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const client = new Anthropic({ apiKey });
  const model = opts.model ?? MODEL;
  const maxTriples = opts.maxTriples ?? 32;

  return async (content: string, tags: string[]): Promise<ExtractedTriple[]> => {
    const tagHint = tags.length ? `\nTags: ${tags.join(", ")}` : "";
    const response = await client.messages.create({
      model,
      max_tokens: 2048,
      system: SYSTEM,
      output_config: { format: { type: "json_schema", schema: TRIPLE_SCHEMA } },
      messages: [{ role: "user", content: `Memory note:\n${content}${tagHint}` }],
    });

    if (response.stop_reason === "refusal") return [];

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return [];

    let parsed: { triples?: ExtractedTriple[] };
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      return [];
    }

    const triples = Array.isArray(parsed.triples) ? parsed.triples : [];
    return triples
      .filter((t) => t && typeof t.from === "string" && typeof t.to === "string" && t.from !== t.to)
      .slice(0, maxTriples);
  };
}
