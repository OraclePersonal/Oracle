import dns from "node:dns/promises";
import net from "node:net";
import { readdown } from "readdown";
import { OracleError } from "../errors.js";
import { firecrawlScrape } from "./providers/firecrawl.js";
import { logWebEvent } from "./log.js";
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
  const start = Date.now();
  if (provider === "firecrawl") {
    try {
      const page = await firecrawlScrape(url);
      logWebEvent({ op: "fetch", provider, outcome: "success", latencyMs: Date.now() - start });
      return page;
    } catch (error) {
      logWebEvent({ op: "fetch", provider, outcome: "failure", latencyMs: Date.now() - start, errorMessage: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  let response: Response;
  let finalUrl: URL;
  try {
    ({ response, finalUrl } = await fetchFollowingSafeRedirects(url, MAX_REDIRECTS));
  } catch (error) {
    logWebEvent({ op: "fetch", provider, outcome: "failure", latencyMs: Date.now() - start, errorMessage: error instanceof Error ? error.message : String(error) });
    if (error instanceof OracleError) throw error;
    throw new OracleError(
      "ORACLE_WEB_UNAVAILABLE",
      `Fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      "Check the URL and network connectivity."
    );
  }
  if (!response.ok) {
    logWebEvent({ op: "fetch", provider, outcome: "failure", latencyMs: Date.now() - start, errorMessage: `HTTP ${response.status}` });
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

  logWebEvent({ op: "fetch", provider, outcome: "success", latencyMs: Date.now() - start, finalUrl: parsed.toString() });

  if (!contentType.includes("html")) {
    return { url: parsed.toString(), title: "", text: raw.slice(0, MAX_TEXT_CHARS) };
  }

  // readdown (readability-style content extraction + markdown conversion,
  // linkedom under the hood) replaces the old regex tag-stripper — it drops
  // nav/ads/sidebars instead of dumping every visible string on the page,
  // and gives proper title/metadata extraction instead of a raw <title> regex.
  const { markdown, metadata } = readdown(raw, { url: parsed.toString() });
  return { url: parsed.toString(), title: metadata.title ?? "", text: markdown.slice(0, MAX_TEXT_CHARS) };
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

/**
 * IPv6 check via a full 8-group expansion instead of raw string-prefix
 * matching. A prefix check on the literal text (e.g. `startsWith("::ffff:")`)
 * misses any IPv4-mapped loopback/private address that isn't written in that
 * exact abbreviated form — dns.lookup()/net can hand back the fully expanded
 * "0:0:0:0:0:ffff:7f00:1" (hex, not dotted-decimal) for 127.0.0.1, which such
 * a check would wave through as a normal public-looking IPv6 address. This
 * mirrors a real disclosed bypass class (CVE-2026-49857, hex-normalized
 * IPv4-mapped IPv6 loopback) in another SSRF filter.
 */
function isPrivateIpv6(address: string): boolean {
  const groups = expandIpv6(address);
  if (!groups) return true; // unparseable — fail closed

  if (groups.every((g) => g === 0)) return true; // :: (unspecified)
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1 (loopback)

  // ::ffff:a.b.c.d — IPv4-mapped, regardless of how the source text wrote it
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const a = (groups[6] >> 8) & 0xff;
    const b = groups[6] & 0xff;
    const c = (groups[7] >> 8) & 0xff;
    const d = groups[7] & 0xff;
    return isPrivateIpv4(`${a}.${b}.${c}.${d}`);
  }

  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (ULA)
  return false;
}

/** Expand any valid textual IPv6 address (any abbreviation) to 8 16-bit groups, or null if unparseable. */
function expandIpv6(address: string): number[] | null {
  if (net.isIP(address) !== 6) return null;
  const [main, zoneStripped] = address.split("%"); // strip zone id (e.g. fe80::1%eth0)
  void zoneStripped;
  const halves = main.split("::");
  if (halves.length > 2) return null;

  const parseSide = (side: string): number[] => (side.length === 0 ? [] : side.split(":").map((h) => parseInt(h, 16)));
  const head = parseSide(halves[0]);
  const tail = halves.length === 2 ? parseSide(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && head.length !== 8)) return null;

  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill(0), ...tail];
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}
