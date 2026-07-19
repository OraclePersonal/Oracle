import { OracleError } from "../../errors.js";
import type { WebSearchResult } from "../types.js";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

/** Web search via the Brave Search API. Requires BRAVE_API_KEY. */
export async function braveSearch(query: string, limit: number): Promise<WebSearchResult[]> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    throw new OracleError(
      "ORACLE_WEB_UNAVAILABLE",
      "BRAVE_API_KEY is not set.",
      "Get a free key at https://brave.com/search/api/ and set BRAVE_API_KEY."
    );
  }

  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(Math.max(limit, 1), 20)));

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": apiKey }
    });
  } catch (error) {
    throw new OracleError(
      "ORACLE_WEB_UNAVAILABLE",
      `Brave Search request failed: ${error instanceof Error ? error.message : String(error)}`,
      "Check network connectivity and try again."
    );
  }

  if (!response.ok) {
    throw new OracleError(
      "ORACLE_WEB_UNAVAILABLE",
      `Brave Search API returned ${response.status}: ${response.statusText}`,
      response.status === 401
        ? "BRAVE_API_KEY looks invalid — check the key at https://brave.com/search/api/."
        : "Try again later; the search API may be rate-limiting or temporarily unavailable."
    );
  }

  const data = (await response.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  const results = data.web?.results ?? [];
  return results.slice(0, limit).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    description: r.description ?? ""
  }));
}
