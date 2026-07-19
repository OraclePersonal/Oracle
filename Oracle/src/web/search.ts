import { OracleError } from "../errors.js";
import { braveSearch } from "./providers/brave.js";
import { tavilySearch } from "./providers/tavily.js";
import { firecrawlSearch } from "./providers/firecrawl.js";
import { SEARCH_PROVIDERS, type SearchProviderName, type WebSearchResult } from "./types.js";

export type { WebSearchResult, SearchProviderName };

const PROVIDER_KEY_ENV: Record<SearchProviderName, string> = {
  brave: "BRAVE_API_KEY",
  tavily: "TAVILY_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY"
};

/** First search provider with a configured API key, in preference order. */
function resolveProvider(): SearchProviderName {
  const configured = SEARCH_PROVIDERS.find((p) => process.env[PROVIDER_KEY_ENV[p]]);
  if (!configured) {
    throw new OracleError(
      "ORACLE_WEB_UNAVAILABLE",
      "No web search provider is configured.",
      `Set one of: ${SEARCH_PROVIDERS.map((p) => PROVIDER_KEY_ENV[p]).join(", ")}.`
    );
  }
  return configured;
}

/**
 * Web search across pluggable providers — Brave, Tavily, or Firecrawl.
 * Picks the first provider with a configured API key when none is given
 * explicitly (checked in that order: Brave's free tier first, then Tavily's
 * LLM-tuned results, then Firecrawl).
 */
export async function webSearch(query: string, limit = 5, provider?: SearchProviderName): Promise<WebSearchResult[]> {
  const selected = provider ?? resolveProvider();
  switch (selected) {
    case "brave": return braveSearch(query, limit);
    case "tavily": return tavilySearch(query, limit);
    case "firecrawl": return firecrawlSearch(query, limit);
    default: throw new OracleError("ORACLE_INVALID_REQUEST", `Unknown search provider: ${selected}`, `Use one of: ${SEARCH_PROVIDERS.join(", ")}.`);
  }
}
