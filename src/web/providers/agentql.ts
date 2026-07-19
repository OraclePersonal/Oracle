import { OracleError } from "../../errors.js";
import { logWebEvent } from "../log.js";

const AGENTQL_ENDPOINT = "https://api.agentql.com/v1/query-data";

export interface ExtractResult {
  sourceUrl: string;
  prompt: string;
  data: unknown;
}

/**
 * Structured data extraction from a URL via TinyFish's AgentQL API — given a
 * page and a natural-language description of what to pull out, returns
 * structured JSON instead of a wall of scraped text. Requires
 * AGENTQL_API_KEY. Unlike the other three providers (search/scrape), this
 * one is specifically for "get me these fields from this page," not
 * "find pages" or "give me readable text."
 *
 * Extraction is the riskiest of the four providers — it depends on page
 * structure that changes without notice, so an empty/near-empty result is
 * validated and rejected here rather than silently returned as if it were a
 * legitimate answer. `sourceUrl` is carried alongside `data` so any fact
 * pulled from this can still be traced back to where it came from.
 */
export async function agentqlExtract(url: string, prompt: string): Promise<ExtractResult> {
  const apiKey = process.env.AGENTQL_API_KEY;
  const start = Date.now();
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
    logWebEvent({ op: "extract", provider: "agentql", outcome: "failure", latencyMs: Date.now() - start, errorMessage: error instanceof Error ? error.message : String(error) });
    throw new OracleError(
      "ORACLE_WEB_UNAVAILABLE",
      `AgentQL request failed: ${error instanceof Error ? error.message : String(error)}`,
      "Check network connectivity and try again."
    );
  }

  if (!response.ok) {
    logWebEvent({ op: "extract", provider: "agentql", outcome: "failure", latencyMs: Date.now() - start, errorMessage: `HTTP ${response.status}` });
    throw new OracleError(
      "ORACLE_WEB_UNAVAILABLE",
      `AgentQL API returned ${response.status}: ${response.statusText}`,
      response.status === 401
        ? "AGENTQL_API_KEY looks invalid — check the key at https://agentql.com/."
        : "Try again later; AgentQL may be rate-limiting or temporarily unavailable."
    );
  }

  const body = (await response.json()) as { data?: unknown };
  const data = "data" in body ? body.data : body;

  if (!hasExtractedContent(data)) {
    logWebEvent({ op: "extract", provider: "agentql", outcome: "failure", latencyMs: Date.now() - start, errorMessage: "empty extraction" });
    throw new OracleError(
      "ORACLE_WEB_UNAVAILABLE",
      `AgentQL returned no extractable data for: ${prompt}`,
      "The page structure may not match the prompt, or the target fields aren't present — try rephrasing the prompt or check the page manually."
    );
  }

  logWebEvent({ op: "extract", provider: "agentql", outcome: "success", latencyMs: Date.now() - start });
  return { sourceUrl: url, prompt, data };
}

function hasExtractedContent(data: unknown): boolean {
  if (data === null || data === undefined) return false;
  if (Array.isArray(data)) return data.length > 0;
  if (typeof data === "object") return Object.keys(data as object).length > 0;
  if (typeof data === "string") return data.trim().length > 0;
  return true;
}
