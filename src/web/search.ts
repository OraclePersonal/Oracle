import { OracleError } from "../errors.js";
import { braveSearch } from "./providers/brave.js";
import { tavilySearch } from "./providers/tavily.js";
import { firecrawlSearch } from "./providers/firecrawl.js";
import { logWebEvent } from "./log.js";
import {
  SEARCH_PROVIDERS,
  type SearchAttempt,
  type SearchProviderName,
  type WebSearchOutcome,
  type WebSearchResult
} from "./types.js";

export type { WebSearchResult, SearchProviderName, WebSearchOutcome, SearchAttempt };

const PROVIDER_KEY_ENV: Record<SearchProviderName, string> = {
  brave: "BRAVE_API_KEY",
  tavily: "TAVILY_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY"
};

const PROVIDER_FN: Record<SearchProviderName, (query: string, limit: number) => Promise<WebSearchResult[]>> = {
  brave: braveSearch,
  tavily: tavilySearch,
  firecrawl: firecrawlSearch
};

function configuredProviders(): SearchProviderName[] {
  return SEARCH_PROVIDERS.filter((p) => process.env[PROVIDER_KEY_ENV[p]]);
}

/**
 * Web search across pluggable providers — Brave, Tavily, or Firecrawl.
 *
 * Routing is explicit and logged, not a silent guess: pass `provider` to
 * pin one; otherwise the first configured provider (Brave → Tavily →
 * Firecrawl) is tried, and on failure the *next* configured provider is
 * tried in turn (a genuine fallback chain, not just "give up"). Every
 * attempt — which provider, why it was chosen, success/failure, latency —
 * is both logged (see log.ts) and returned in `attempts` on the outcome, so
 * a bad or empty answer can be traced back to what actually happened
 * instead of a single opaque result array.
 */
export async function webSearchWithTrace(
  query: string,
  limit = 5,
  provider?: SearchProviderName
): Promise<WebSearchOutcome> {
  const candidates: Array<{ name: SearchProviderName; reason: SearchAttempt["reason"] }> = provider
    ? [{ name: provider, reason: "explicit" }]
    : configuredProviders().map((name, i) => ({ name, reason: i === 0 ? "auto-detected" as const : "fallback" as const }));

  if (candidates.length === 0) {
    throw new OracleError(
      "ORACLE_WEB_UNAVAILABLE",
      "No web search provider is configured.",
      `Set one of: ${SEARCH_PROVIDERS.map((p) => PROVIDER_KEY_ENV[p]).join(", ")}.`
    );
  }

  const attempts: SearchAttempt[] = [];
  for (const candidate of candidates) {
    const start = Date.now();
    try {
      const results = await PROVIDER_FN[candidate.name](query, limit);
      const latencyMs = Date.now() - start;
      attempts.push({ provider: candidate.name, reason: candidate.reason, outcome: "success", latencyMs });
      logWebEvent({ op: "search", provider: candidate.name, reason: candidate.reason, outcome: "success", latencyMs, resultCount: results.length });
      return { provider: candidate.name, results, attempts };
    } catch (error) {
      const latencyMs = Date.now() - start;
      const errorMessage = error instanceof Error ? error.message : String(error);
      attempts.push({ provider: candidate.name, reason: candidate.reason, outcome: "failure", errorMessage, latencyMs });
      logWebEvent({ op: "search", provider: candidate.name, reason: candidate.reason, outcome: "failure", latencyMs, errorMessage });
      // Only fall through to the next candidate for an unconfigured/unavailable
      // provider — a bad query or invalid-request error would fail identically
      // on every other provider too, so retrying it is pure wasted latency.
      if (!(error instanceof OracleError) || error.code !== "ORACLE_WEB_UNAVAILABLE") throw error;
    }
  }

  throw new OracleError(
    "ORACLE_WEB_UNAVAILABLE",
    `All configured search providers failed: ${attempts.map((a) => `${a.provider} (${a.errorMessage})`).join("; ")}`,
    "Check each provider's API key, or pass an explicit provider to see its specific error."
  );
}

/** Convenience wrapper over webSearchWithTrace() for callers that just want results. */
export async function webSearch(query: string, limit = 5, provider?: SearchProviderName): Promise<WebSearchResult[]> {
  const outcome = await webSearchWithTrace(query, limit, provider);
  return outcome.results;
}
