import { describe, it, expect, vi, afterEach } from "vitest";
import dns from "node:dns/promises";
import { fetchUrl } from "./fetchUrl.js";
import { OracleError } from "../errors.js";

vi.mock("node:dns/promises", () => ({
  default: { lookup: vi.fn() }
}));

describe("fetchUrl", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.mocked(dns.lookup).mockReset();
  });

  function mockPublicDns() {
    vi.mocked(dns.lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as any);
  }

  it("rejects invalid URLs", async () => {
    await expect(fetchUrl("not a url")).rejects.toThrow(OracleError);
  });

  it("rejects non-http(s) protocols", async () => {
    await expect(fetchUrl("ftp://example.com/file")).rejects.toThrow(OracleError);
  });

  it("rejects an IP-literal URL pointing at a private/loopback address", async () => {
    await expect(fetchUrl("http://127.0.0.1/admin")).rejects.toThrow(OracleError);
    await expect(fetchUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(OracleError);
    await expect(fetchUrl("http://10.0.0.5/internal")).rejects.toThrow(OracleError);
    await expect(fetchUrl("http://192.168.1.1/")).rejects.toThrow(OracleError);
    await expect(fetchUrl("http://[::1]/")).rejects.toThrow(OracleError);
  });

  it("rejects a hostname that resolves to a private address", async () => {
    vi.mocked(dns.lookup).mockResolvedValue([{ address: "10.0.0.1", family: 4 }] as any);
    await expect(fetchUrl("http://internal.example.com/")).rejects.toThrow(OracleError);
  });

  it("rejects hex-normalized IPv4-mapped IPv6 loopback/private addresses regardless of textual form", async () => {
    // A string-prefix check like startsWith("::ffff:") misses these — the
    // address is still ::ffff:0:0/96 (or fe80::/fc00::), just not spelled
    // the way the check expected. This is the shape of a real disclosed
    // bypass (CVE-2026-49857).
    const cases = [
      "0:0:0:0:0:ffff:7f00:1",     // 127.0.0.1, fully expanded hex
      "::ffff:7f00:1",             // 127.0.0.1, hex tail instead of dotted-decimal
      "::ffff:a9fe:a9fe",          // 169.254.169.254 (cloud metadata), hex
      "0:0:0:0:0:ffff:a00:1",      // 10.0.0.1, fully expanded hex
    ];
    for (const literal of cases) {
      vi.mocked(dns.lookup).mockResolvedValue([{ address: literal, family: 6 }] as any);
      await expect(fetchUrl("http://internal.example.com/"), literal).rejects.toThrow(OracleError);
    }
  });

  it("still allows a genuinely public IPv4-mapped IPv6 address", async () => {
    mockPublicDns();
    vi.mocked(dns.lookup).mockResolvedValue([{ address: "::ffff:5db8:d822", family: 6 }] as any); // 93.184.216.34
    global.fetch = vi.fn(async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } })) as any;
    const page = await fetchUrl("https://example.com");
    expect(page.text).toBe("ok");
  });

  it("does not call fetch when the host is rejected", async () => {
    global.fetch = vi.fn() as any;
    await expect(fetchUrl("http://127.0.0.1/")).rejects.toThrow(OracleError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("strips HTML to readable text and extracts the title", async () => {
    mockPublicDns();
    global.fetch = vi.fn(async () =>
      new Response(
        "<html><head><title>Redis &amp; Cache</title><style>.x{}</style></head>" +
        "<body><script>evil()</script><h1>Hello</h1><p>World &nbsp;here</p></body></html>",
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
      )
    ) as any;

    const page = await fetchUrl("https://example.com");
    expect(page.title).toBe("Redis & Cache");
    expect(page.text).toContain("Hello");
    expect(page.text).toContain("World");
    expect(page.text).toContain("here");
    expect(page.text).not.toContain("evil()");
    expect(page.text).not.toContain("<h1>");
  });

  it("returns raw text as-is for non-HTML content types", async () => {
    mockPublicDns();
    global.fetch = vi.fn(async () =>
      new Response("plain text body", { status: 200, headers: { "content-type": "text/plain" } })
    ) as any;
    const page = await fetchUrl("https://example.com/robots.txt");
    expect(page.text).toBe("plain text body");
    expect(page.title).toBe("");
  });

  it("throws ORACLE_WEB_UNAVAILABLE on non-ok response", async () => {
    mockPublicDns();
    global.fetch = vi.fn(async () => new Response("", { status: 404, statusText: "Not Found" })) as any;
    await expect(fetchUrl("https://example.com/missing")).rejects.toThrow(OracleError);
  });

  it("throws ORACLE_WEB_UNAVAILABLE when the request itself fails", async () => {
    mockPublicDns();
    global.fetch = vi.fn(async () => { throw new Error("dns fail"); }) as any;
    await expect(fetchUrl("https://example.com")).rejects.toThrow(OracleError);
  });

  it("follows a redirect to a public host but rejects one pointing at a private address", async () => {
    mockPublicDns();
    global.fetch = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/internal" } })
    ) as any;
    await expect(fetchUrl("https://example.com/redirect")).rejects.toThrow(OracleError);
  });

  it("follows a safe redirect chain to its final content", async () => {
    mockPublicDns();
    let call = 0;
    global.fetch = vi.fn(async () => {
      call++;
      if (call === 1) return new Response(null, { status: 302, headers: { location: "https://example.com/final" } });
      return new Response("final page", { status: 200, headers: { "content-type": "text/plain" } });
    }) as any;
    const page = await fetchUrl("https://example.com/redirect");
    expect(page.text).toBe("final page");
    expect(page.url).toBe("https://example.com/final");
  });

  it("delegates to Firecrawl and skips the native SSRF/DNS path entirely when provider is 'firecrawl'", async () => {
    const originalKey = process.env.FIRECRAWL_API_KEY;
    process.env.FIRECRAWL_API_KEY = "test-key";
    global.fetch = vi.fn(async (url: any) => {
      expect(String(url)).toContain("api.firecrawl.dev/v1/scrape");
      return new Response(JSON.stringify({ data: { markdown: "content", metadata: { title: "T" } } }), { status: 200 });
    }) as any;

    const page = await fetchUrl("https://example.com", "firecrawl");
    expect(page.text).toBe("content");
    expect(dns.lookup).not.toHaveBeenCalled();

    if (originalKey === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = originalKey;
  });
});
