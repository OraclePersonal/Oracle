import dns from "node:dns/promises";
import net from "node:net";
import { OracleError } from "../errors.js";
import { firecrawlScrape } from "./providers/firecrawl.js";
import type { FetchProviderName } from "./types.js";

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
}

const MAX_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 20_000;
const MAX_REDIRECTS = 5;

/**
 * Fetch a URL and reduce it to readable plain text.
 *
 * Default ("native") is deliberately basic (tag strip + entity decode, no
 * DOM/readability library, no JS rendering) — this is for pulling a doc
 * page's prose into a prompt, not for rendering or scraping structure. Pass
 * provider "firecrawl" for JS-rendered pages Firecrawl converts to clean
 * markdown remotely (requires FIRECRAWL_API_KEY); the SSRF guard below only
 * applies to the native path since Firecrawl does its own fetching.
 *
 * The native path is exposed as an MCP tool an agent can call with an
 * arbitrary URL, so every hop (including redirects) is resolved and checked
 * against private/loopback/link-local ranges before connecting — otherwise
 * a prompt could make Oracle fetch http://169.254.169.254/ (cloud metadata)
 * or an internal service on localhost. `fetch`'s built-in redirect following
 * is disabled for the same reason: it would bypass this check on hop 2+.
 */
export async function fetchUrl(url: string, provider: FetchProviderName = "native"): Promise<FetchedPage> {
  if (provider === "firecrawl") return firecrawlScrape(url);

  let response: Response;
  let finalUrl: URL;
  try {
    ({ response, finalUrl } = await fetchFollowingSafeRedirects(url, MAX_REDIRECTS));
  } catch (error) {
    if (error instanceof OracleError) throw error;
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
  const parsed = finalUrl;

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

async function fetchFollowingSafeRedirects(
  url: string,
  redirectsLeft: number
): Promise<{ response: Response; finalUrl: URL }> {
  const parsed = parseAndValidateUrl(url);
  await assertPublicHost(parsed.hostname);

  const response = await fetch(parsed, {
    headers: { "User-Agent": "oracle-cli/1.0" },
    redirect: "manual"
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: parsed };
    if (redirectsLeft <= 0) {
      throw new OracleError("ORACLE_WEB_UNAVAILABLE", "Too many redirects.", "The target URL redirects too many times.");
    }
    const next = new URL(location, parsed);
    return fetchFollowingSafeRedirects(next.toString(), redirectsLeft - 1);
  }

  return { response, finalUrl: parsed };
}

function parseAndValidateUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OracleError("ORACLE_INVALID_REQUEST", `Invalid URL: ${url}`, "Pass a full http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new OracleError("ORACLE_INVALID_REQUEST", `Unsupported protocol: ${parsed.protocol}`, "Only http/https URLs are supported.");
  }
  return parsed;
}

/**
 * Resolve `hostname` and reject it if any resolved address is private,
 * loopback, link-local (incl. the 169.254.169.254 cloud metadata address),
 * or otherwise non-public — the whole point of this tool being callable by
 * an agent is defeated if it can be pointed at internal infrastructure.
 */
async function assertPublicHost(hostname: string): Promise<void> {
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new OracleError("ORACLE_INVALID_REQUEST", `Refusing to fetch private/internal address: ${hostname}`, "Only public URLs are supported.");
    }
    return;
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (error) {
    throw new OracleError(
      "ORACLE_WEB_UNAVAILABLE",
      `DNS resolution failed for ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
      "Check the hostname is correct."
    );
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new OracleError("ORACLE_INVALID_REQUEST", `Refusing to fetch private/internal address: ${hostname} resolves to ${address}`, "Only public URLs are supported.");
    }
  }
}

function isPrivateAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true; // unresolvable/unknown — fail closed
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) return true;
  const [a, b] = octets;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
  if (a === 0) return true; // "this" network
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast/reserved
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true; // loopback
  if (normalized === "::") return true; // unspecified
  if (normalized.startsWith("::ffff:")) return isPrivateIpv4(normalized.slice("::ffff:".length));
  if (normalized.startsWith("fe80:") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true; // link-local
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local (ULA)
  return false;
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
