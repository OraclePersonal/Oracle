import { OracleError } from "../../errors.js";
import type { WebSearchResult } from "../types.js";

const FIRECRAWL_SEARCH_ENDPOINT = "https://api.firecrawl.dev/v1/search";
const FIRECRAWL_SCRAPE_ENDPOINT = "https://api.firecrawl.dev/v1/scrape";

function requireApiKey(): string {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new OracleError(
      "ORACLE_WEB_UNAVAILABLE",
      "FIRECRAWL_API_KEY is not set.",
      "Get a key at https://firecrawl.dev/ and set FIRECRAWL_API_KEY."
    );
  }
  return apiKey;
}

async function postJson(url: string, apiKey: string, body: unknown): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new OracleError(
      "ORACLE_WEB_UNAVAILABLE",
      `Firecrawl request failed: ${error instanceof Error ? error.message : String(error)}`,
      "Check network connectivity and try again."
    );
  }
  if (!response.ok) {
    throw new OracleError(
      "ORACLE_WEB_UNAVAILABLE",
      `Firecrawl API returned ${response.status}: ${response.statusText}`,
      response.status === 401
        ? "FIRECRAWL_API_KEY looks invalid — check the key at https://firecrawl.dev/."
        : "Try again later; Firecrawl may be rate-limiting or temporarily unavailable."
    );
  }
  return response.json();
}

/** Web search via Firecrawl's /search endpoint. Requires FIRECRAWL_API_KEY. */
export async function firecrawlSearch(query: string, limit: number): Promise<WebSearchResult[]> {
  const apiKey = requireApiKey();
  const data = (await postJson(FIRECRAWL_SEARCH_ENDPOINT, apiKey, {
    query,
    limit: Math.min(Math.max(limit, 1), 20)
  })) as { data?: Array<{ title?: string; url?: string; description?: string }> };
  return (data.data ?? []).slice(0, limit).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    description: r.description ?? ""
  }));
}

export interface ScrapedPage {
  url: string;
  title: string;
  text: string;
}

/**
 * Fetch a URL via Firecrawl's /scrape endpoint (JS-rendered, returns clean
 * markdown) instead of Oracle's own raw-HTML fetch — useful for pages that
 * need a real browser to render. Requires FIRECRAWL_API_KEY.
 */
export async function firecrawlScrape(url: string): Promise<ScrapedPage> {
  const apiKey = requireApiKey();
  const data = (await postJson(FIRECRAWL_SCRAPE_ENDPOINT, apiKey, {
    url,
    formats: ["markdown"]
  })) as { data?: { markdown?: string; metadata?: { title?: string; sourceURL?: string } } };
  const markdown = data.data?.markdown ?? "";
  const title = data.data?.metadata?.title ?? "";
  const sourceUrl = data.data?.metadata?.sourceURL ?? url;
  return { url: sourceUrl, title, text: markdown.slice(0, 20_000) };
}
