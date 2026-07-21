import { OracleError } from "../../errors.js";
import type { WebSearchResult } from "../types.js";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

/** Web search via the Tavily API (search results tuned for LLM consumption). Requires TAVILY_API_KEY. */
export async function tavilySearch(query: string, limit: number): Promise<WebSearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new OracleError(
      "ORACLE_WEB_UNAVAILABLE",
      "TAVILY_API_KEY is not set.",
      "Get a key at https://tavily.com/ and set TAVILY_API_KEY."
    );
  }

  let response: Response;
  try {
    response = await fetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, max_results: Math.min(Math.max(limit, 1), 20) })
    });
  } catch (error) {
    throw new OracleError(
      "ORACLE_WEB_UNAVAILABLE",
      `Tavily request failed: ${error instanceof Error ? error.message : String(error)}`,
      "Check network connectivity and try again."
    );
  }

  if (!response.ok) {
    throw new OracleError(
      "ORACLE_WEB_UNAVAILABLE",
      `Tavily API returned ${response.status}: ${response.statusText}`,
      response.status === 401
        ? "TAVILY_API_KEY looks invalid — check the key at https://tavily.com/."
        : "Try again later; Tavily may be rate-limiting or temporarily unavailable."
    );
  }

  const data = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const results = data.results ?? [];
  return results.slice(0, limit).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    description: r.content ?? ""
  }));
}
