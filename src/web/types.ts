export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
}

export type SearchProviderName = "brave" | "tavily" | "firecrawl";
export type FetchProviderName = "native" | "firecrawl";

export const SEARCH_PROVIDERS: SearchProviderName[] = ["brave", "tavily", "firecrawl"];
export const FETCH_PROVIDERS: FetchProviderName[] = ["native", "firecrawl"];
