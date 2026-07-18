/**
 * Contradiction detection for memory writes.
 *
 * When a new memory contradicts an existing one ("prefers tabs" → later
 * "prefers spaces"), a naive store keeps both and recall returns a coin-flip.
 * This module finds those contradictions so `remember` can resolve them:
 * supersede the stale side (temporal invalidation), quarantine an untrusted
 * one (contamination guard), or flag a genuine tie for review.
 *
 * Two detectors:
 *  - `detectConflictsHeuristic` — pure, deterministic, no network. Catches the
 *    common shapes: negation asymmetry, antonym flips, and single-value
 *    reassignment for preference/config verbs ("uses X" vs "uses Y").
 *  - `createLlmConflictDetector` — optional Claude-backed detector for the
 *    subtler semantic contradictions heuristics miss. Returns null without a
 *    key, so callers can wire it unconditionally.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { MemoryEntry } from "./types.js";

export interface ConflictCandidate {
  /** The existing memory the incoming one contradicts. */
  entry: MemoryEntry;
  /** 0-1 confidence that this is a real contradiction (not just related). */
  score: number;
  /** Human-legible reason, e.g. "negation flip on 'cache'". */
  reason: string;
}

export type ConflictDetector = (
  incoming: { content: string; tags: string[] },
  existing: MemoryEntry[],
) => Promise<ConflictCandidate[]>;

// ── Heuristic detector ─────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "to", "of", "and", "or",
  "in", "on", "for", "with", "we", "it", "this", "that", "should", "will",
  "our", "use", "using", "used", "now", "when", "do", "does", "not", "no",
  "never", "always", "prefer", "prefers", "preferred",
]);

const NEGATIONS = ["not", "no", "never", "n't", "without", "avoid", "disallow", "don't", "doesn't", "isn't", "won't"];

/** Antonym pairs — a term from one side vs. its partner signals a flip. */
const ANTONYMS: [string, string][] = [
  ["enabled", "disabled"], ["enable", "disable"], ["allow", "deny"],
  ["allowed", "denied"], ["true", "false"], ["on", "off"], ["yes", "no"],
  ["accept", "reject"], ["include", "exclude"], ["public", "private"],
  ["sync", "async"], ["synchronous", "asynchronous"], ["tabs", "spaces"],
  ["light", "dark"], ["increase", "decrease"], ["add", "remove"],
  ["start", "stop"], ["open", "closed"], ["up", "down"], ["required", "optional"],
];

/** Verbs whose object is a single chosen value — a different object = a reassignment. */
const ASSIGNMENT_VERBS = ["uses", "use", "prefers", "prefer", "chose", "chosen", "selected", "runs", "runs on", "defaults to", "set to", "configured to", "lives in", "listens on", "is"];

/**
 * Measure/filler nouns that sit between the verb and the actual value
 * ("runs on **port** 9000", "on **version** 16"). Skipped so the object
 * extractor reaches the value that actually changes, not the unit word.
 */
const ASSIGNMENT_FILLERS = new Set([
  "port", "version", "value", "number", "level", "mode", "type", "name",
  "host", "address", "branch", "default", "by", "at", "on", "of", "its",
  "the", "a", "an", "our", "their",
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'+.-]*/g) ?? []).filter((t) => t.length > 1);
}

function contentTerms(text: string): Set<string> {
  return new Set(tokenize(text).filter((t) => !STOPWORDS.has(t)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function hasNegation(tokens: string[]): boolean {
  return tokens.some((t) => NEGATIONS.includes(t));
}

/** Extract the object of the first assignment verb, e.g. "uses redis" → "redis". */
function assignmentObject(text: string): { verb: string; object: string } | null {
  const lower = ` ${text.toLowerCase()} `;
  for (const verb of ASSIGNMENT_VERBS) {
    const idx = lower.indexOf(` ${verb} `);
    if (idx === -1) continue;
    const after = lower.slice(idx + verb.length + 2);
    // Skip stopwords AND measure/filler nouns to reach the real value token
    // ("runs on port 9000" → "9000", not "port").
    const obj = tokenize(after).find((t) => !STOPWORDS.has(t) && !ASSIGNMENT_FILLERS.has(t));
    if (obj) return { verb, object: obj };
  }
  return null;
}

/**
 * Detect likely contradictions between an incoming memory and existing ones.
 * Only same-subject pairs (high term overlap) are considered — two unrelated
 * memories are never in conflict just because one contains "not".
 */
export function detectConflictsHeuristic(
  incoming: { content: string; tags: string[] },
  existing: MemoryEntry[],
): ConflictCandidate[] {
  const inTerms = contentTerms(incoming.content);
  const inTokens = tokenize(incoming.content);
  const inTags = new Set(incoming.tags.map((t) => t.toLowerCase()));
  const inNeg = hasNegation(inTokens);
  const inAssign = assignmentObject(incoming.content);

  const out: ConflictCandidate[] = [];

  for (const e of existing) {
    if (e.archived || e.pruned || e.validTo) continue;

    const exTerms = contentTerms(e.content);
    const exTokens = tokenize(e.content);
    const exTags = new Set(e.tags.map((t) => t.toLowerCase()));

    // Same subject? Require meaningful topical overlap via content OR shared tags.
    const termSim = jaccard(inTerms, exTerms);
    const tagSim = jaccard(inTags, exTags);
    const sameSubject = termSim >= 0.34 || (tagSim >= 0.5 && termSim >= 0.15);
    if (!sameSubject) continue;

    const shared = [...inTerms].filter((t) => exTerms.has(t));

    // 1. Negation asymmetry: same subject, opposite polarity.
    if (inNeg !== hasNegation(exTokens) && shared.length > 0) {
      out.push({ entry: e, score: Math.min(0.9, 0.55 + termSim), reason: `negation flip on ${shared.slice(0, 3).join(", ")}` });
      continue;
    }

    // 2. Antonym flip: a term on one side has its antonym on the other.
    const antonym = ANTONYMS.find(
      ([x, y]) => (inTerms.has(x) && exTerms.has(y)) || (inTerms.has(y) && exTerms.has(x)),
    );
    if (antonym) {
      out.push({ entry: e, score: Math.min(0.9, 0.6 + termSim), reason: `antonym flip ${antonym[0]}/${antonym[1]}` });
      continue;
    }

    // 3. Single-value reassignment: same verb, different object.
    const exAssign = assignmentObject(e.content);
    if (inAssign && exAssign && inAssign.object !== exAssign.object && termSim >= 0.34) {
      out.push({ entry: e, score: Math.min(0.85, 0.5 + termSim), reason: `reassignment: ${exAssign.object} → ${inAssign.object}` });
      continue;
    }
  }

  return out.sort((a, b) => b.score - a.score);
}

// ── LLM detector ────────────────────────────────────────────────────────────

const MODEL = "claude-opus-4-8";

const CONFLICT_SCHEMA = {
  type: "object",
  properties: {
    conflicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "ID of the existing memory that is contradicted" },
          score: { type: "number", description: "0-1 confidence this is a real contradiction" },
          reason: { type: "string", description: "Short explanation of the contradiction" },
        },
        required: ["id", "score", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["conflicts"],
  additionalProperties: false,
} as const;

const SYSTEM = `You detect factual contradictions for an AI agent's memory store.
Given one INCOMING memory note and a list of EXISTING memories (each with an id),
return only the existing memories whose statements are directly contradicted or
made obsolete by the incoming note (e.g. a changed preference, a reversed
decision, a superseded value). Do NOT flag memories that merely share a topic,
add detail, or are consistent. Return an empty list if nothing is contradicted.`;

export interface LlmConflictOptions {
  apiKey?: string;
  model?: string;
  /** Cap existing memories sent per call (token guard). */
  maxCandidates?: number;
}

export function createLlmConflictDetector(opts: LlmConflictOptions = {}): ConflictDetector | null {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const client = new Anthropic({ apiKey });
  const model = opts.model ?? MODEL;
  const maxCandidates = opts.maxCandidates ?? 40;

  return async (incoming, existing) => {
    const candidates = existing.filter((e) => !e.archived && !e.pruned && !e.validTo).slice(0, maxCandidates);
    if (candidates.length === 0) return [];

    const byId = new Map(candidates.map((e) => [e.id, e]));
    const list = candidates.map((e) => `- id=${e.id}: ${e.content.replace(/\s+/g, " ").slice(0, 400)}`).join("\n");
    const tagHint = incoming.tags.length ? `\nTags: ${incoming.tags.join(", ")}` : "";

    let response;
    try {
      response = await client.messages.create({
        model,
        max_tokens: 1024,
        system: SYSTEM,
        output_config: { format: { type: "json_schema", schema: CONFLICT_SCHEMA } },
        messages: [{ role: "user", content: `INCOMING:\n${incoming.content}${tagHint}\n\nEXISTING:\n${list}` }],
      });
    } catch {
      return [];
    }

    if (response.stop_reason === "refusal") return [];
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return [];

    let parsed: { conflicts?: { id: string; score: number; reason: string }[] };
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      return [];
    }

    const conflicts = Array.isArray(parsed.conflicts) ? parsed.conflicts : [];
    return conflicts
      .map((c) => {
        const entry = byId.get(c.id);
        if (!entry) return null;
        return { entry, score: typeof c.score === "number" ? c.score : 0.6, reason: c.reason ?? "llm-detected contradiction" };
      })
      .filter((c): c is ConflictCandidate => c !== null && c.score >= 0.5)
      .sort((a, b) => b.score - a.score);
  };
}

/**
 * Combined trust of a memory for conflict arbitration: how much we believe it,
 * weighted mostly by content confidence and partly by source trust.
 */
export function memoryTrust(e: { confidence?: number; sourceTrust?: number }): number {
  const conf = e.confidence ?? 0.7;
  const trust = e.sourceTrust ?? 0.5;
  return conf * 0.65 + trust * 0.35;
}
