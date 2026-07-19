import { OracleError } from "../errors.js";

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
}

const MAX_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 20_000;

/**
 * Fetch a URL and reduce it to readable plain text. Deliberately basic (tag
 * strip + entity decode, no DOM/readability library) — this is for pulling
 * a doc page's prose into a prompt, not for rendering or scraping structure.
 */
export async function fetchUrl(url: string): Promise<FetchedPage> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OracleError("ORACLE_INVALID_REQUEST", `Invalid URL: ${url}`, "Pass a full http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new OracleError("ORACLE_INVALID_REQUEST", `Unsupported protocol: ${parsed.protocol}`, "Only http/https URLs are supported.");
  }

  let response: Response;
  try {
    response = await fetch(parsed, { headers: { "User-Agent": "oracle-cli/1.0" } });
  } catch (error) {
    throw new OracleError(
      "ORACLE_WEB_UNAVAILABLE",
      `Fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      "Check the URL and network connectivity."
    );
  }
  if (!response.ok) {
    throw new OracleError(
      "ORACLE_WEB_UNAVAILABLE",
      `Fetch returned ${response.status}: ${response.statusText}`,
      "Check that the URL is reachable and not behind auth."
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  const buf = await response.arrayBuffer();
  const raw = Buffer.from(buf.slice(0, MAX_BYTES)).toString("utf8");

  if (!contentType.includes("html")) {
    return { url: parsed.toString(), title: "", text: raw.slice(0, MAX_TEXT_CHARS) };
  }

  const titleMatch = raw.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : "";
  const text = htmlToText(raw).slice(0, MAX_TEXT_CHARS);
  return { url: parsed.toString(), title, text };
}

function htmlToText(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const withBreaks = withoutNoise
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withBreaks)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
