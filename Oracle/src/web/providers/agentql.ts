import { OracleError } from "../../errors.js";

const AGENTQL_ENDPOINT = "https://api.agentql.com/v1/query-data";

/**
 * Structured data extraction from a URL via TinyFish's AgentQL API — given a
 * page and a natural-language description of what to pull out, returns
 * structured JSON instead of a wall of scraped text. Requires
 * AGENTQL_API_KEY. Unlike the other three providers (search/scrape), this
 * one is specifically for "get me these fields from this page," not
 * "find pages" or "give me readable text."
 */
export async function agentqlExtract(url: string, prompt: string): Promise<unknown> {
  const apiKey = process.env.AGENTQL_API_KEY;
  if (!apiKey) {
    throw new OracleError(
      "ORACLE_WEB_UNAVAILABLE",
      "AGENTQL_API_KEY is not set.",
      "Get a key at https://agentql.com/ (TinyFish) and set AGENTQL_API_KEY."
    );
  }

  let response: Response;
  try {
    response = await fetch(AGENTQL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ url, prompt })
    });
  } catch (error) {
    throw new OracleError(
      "ORACLE_WEB_UNAVAILABLE",
      `AgentQL request failed: ${error instanceof Error ? error.message : String(error)}`,
      "Check network connectivity and try again."
    );
  }

  if (!response.ok) {
    throw new OracleError(
      "ORACLE_WEB_UNAVAILABLE",
      `AgentQL API returned ${response.status}: ${response.statusText}`,
      response.status === 401
        ? "AGENTQL_API_KEY looks invalid — check the key at https://agentql.com/."
        : "Try again later; AgentQL may be rate-limiting or temporarily unavailable."
    );
  }

  const data = (await response.json()) as { data?: unknown };
  return data.data ?? data;
}
