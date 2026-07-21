export type SearchProviderName = "brave" | "tavily" | "firecrawl";
export type FetchProviderName = "native" | "firecrawl";

export const SEARCH_PROVIDERS: SearchProviderName[] = ["brave", "tavily", "firecrawl"];
export const FETCH_PROVIDERS: FetchProviderName[] = ["native", "firecrawl"];

/** title/url/description are the normalized shape every search provider maps into. */
export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
}

/**
 * One provider attempt during a webSearch() call. Kept alongside the results
 * so a caller (or a human debugging a bad answer) can see the routing
 * decision instead of a single opaque result set — which provider ran, why,
 * whether it failed, and what the fallback chain looked like.
 */
export interface SearchAttempt {
  provider: SearchProviderName;
  reason: "explicit" | "auto-detected" | "fallback";
  outcome: "success" | "failure";
  errorMessage?: string;
  latencyMs: number;
}

export interface WebSearchOutcome {
  provider: SearchProviderName;
  results: WebSearchResult[];
  attempts: SearchAttempt[];
}
