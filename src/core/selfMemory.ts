import { estimateTokens } from "readdown";
import type { MemoryPort } from "../orchestrator/ports.js";

const SELF_LOG_AGENT = "oracle";
const SELF_LOG_TAG = "self-log";

export interface SelfLogEntry {
  question: string;
  answerSummary: string;
  ts: string;
}

/**
 * Self-model memory — separate from the fact/insight memory that models the
 * *user*, this tracks what Oracle itself has already said within a
 * conversation. Without it, a long multi-turn oracle_ask exchange can
 * contradict or repeat itself, because each call is otherwise stateless
 * apart from the caller re-pasting context by hand. Scoped by `sessionId` so
 * unrelated conversations don't bleed into each other; stored as a
 * `working` memory (auto-clears with the rest of working memory) rather
 * than a durable fact, since "what I said a minute ago" isn't a fact worth
 * keeping forever.
 */
export async function recordSelfLog(
  memory: MemoryPort,
  sessionId: string,
  entry: Omit<SelfLogEntry, "ts">
): Promise<void> {
  const full: SelfLogEntry = { ...entry, ts: new Date().toISOString() };
  await memory.remember(SELF_LOG_AGENT, "working", JSON.stringify(full), {
    tags: [SELF_LOG_TAG, sessionId]
  });
}

export async function getSelfLog(memory: MemoryPort, sessionId: string, limit = 5): Promise<SelfLogEntry[]> {
  // recall()'s tags filter is OR, not AND — passing both [SELF_LOG_TAG, sessionId]
  // would also match any other session's self-log entries. Query by the
  // (effectively unique) sessionId tag alone, then require SELF_LOG_TAG too.
  const entries = await memory.recall({ agent: SELF_LOG_AGENT, tags: [sessionId], limit: limit * 2 });
  return entries
    .filter((e) => e.tags.includes(SELF_LOG_TAG))
    .slice(0, limit)
    .map((e) => {
      try {
        return JSON.parse(e.content) as SelfLogEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is SelfLogEntry => e !== null);
}

/** Render prior self-log entries as a context block, or "" if there are none. */
export function formatSelfLog(entries: SelfLogEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries
    .slice()
    .reverse()
    .map((e) => `- Q: ${e.question}\n  A: ${e.answerSummary}`)
    .join("\n");
  return `\n\n## What I already told you earlier in this session\n${lines}`;
}

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_MAX_CONTEXT_TOKENS = 1500;

/**
 * Context-window-aware version of getSelfLog()+formatSelfLog(): fetches up
 * to `maxTurns` recent turns, then keeps only as many of the *most recent*
 * ones as fit under `maxTokens` (via readdown's estimateTokens — reused
 * rather than hand-rolling token counting). A long-running conversation
 * would otherwise grow this block without bound every turn, silently
 * ballooning the prompt sent to the model call after call. Older turns that
 * don't fit are dropped, not silently lost from the underlying log — they
 * stay in memory, just outside this call's context window — and the block
 * says how many were left out so it's visible rather than a mystery gap.
 */
export async function getConversationContext(
  memory: MemoryPort,
  sessionId: string,
  opts: { maxTokens?: number; maxTurns?: number } = {}
): Promise<string> {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const entries = await getSelfLog(memory, sessionId, maxTurns); // newest-first

  const included: SelfLogEntry[] = [];
  let usedTokens = 0;
  for (const entry of entries) {
    const tokens = estimateTokens(`- Q: ${entry.question}\n  A: ${entry.answerSummary}`).tokens;
    // Stop at the first turn that would blow the budget rather than skipping
    // it and checking older ones — the window must stay a contiguous run of
    // the most recent turns, not a cherry-picked scatter of whichever
    // happened to be short enough to fit.
    if (usedTokens + tokens > maxTokens) break;
    included.push(entry);
    usedTokens += tokens;
  }

  const omitted = entries.length - included.length;
  const block = formatSelfLog(included);
  if (omitted === 0) return block;
  return `${block}\n\n(${omitted} earlier turn${omitted === 1 ? "" : "s"} in this session omitted to stay within the context budget)`;
}
