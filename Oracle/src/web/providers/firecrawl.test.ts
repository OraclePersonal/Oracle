import { describe, it, expect, vi, afterEach } from "vitest";
import { firecrawlSearch, firecrawlScrape } from "./firecrawl.js";
import { OracleError } from "../../errors.js";

describe("firecrawl provider", () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.FIRECRAWL_API_KEY;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = originalKey;
  });

  it("firecrawlSearch throws ORACLE_WEB_UNAVAILABLE when FIRECRAWL_API_KEY is unset", async () => {
    delete process.env.FIRECRAWL_API_KEY;
    await expect(firecrawlSearch("test", 5)).rejects.toThrow(OracleError);
  });

  it("firecrawlSearch returns mapped results on success", async () => {
    process.env.FIRECRAWL_API_KEY = "test-key";
    global.fetch = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain("api.firecrawl.dev/v1/search");
      expect(init.headers.Authorization).toBe("Bearer test-key");
      return new Response(
        JSON.stringify({ data: [{ title: "Redis Docs", url: "https://redis.io", description: "d" }] }),
        { status: 200 }
      );
    }) as any;
    const results = await firecrawlSearch("redis", 5);
    expect(results).toEqual([{ title: "Redis Docs", url: "https://redis.io", description: "d" }]);
  });

  it("firecrawlScrape throws ORACLE_WEB_UNAVAILABLE when FIRECRAWL_API_KEY is unset", async () => {
    delete process.env.FIRECRAWL_API_KEY;
    await expect(firecrawlScrape("https://example.com")).rejects.toThrow(OracleError);
  });

  it("firecrawlScrape returns markdown and metadata on success", async () => {
    process.env.FIRECRAWL_API_KEY = "test-key";
    global.fetch = vi.fn(async (url: any) => {
      expect(String(url)).toContain("api.firecrawl.dev/v1/scrape");
      return new Response(
        JSON.stringify({ data: { markdown: "# Hello", metadata: { title: "Hi", sourceURL: "https://example.com/final" } } }),
        { status: 200 }
      );
    }) as any;
    const page = await firecrawlScrape("https://example.com");
    expect(page).toEqual({ url: "https://example.com/final", title: "Hi", text: "# Hello" });
  });

  it("throws ORACLE_WEB_UNAVAILABLE on non-ok response", async () => {
    process.env.FIRECRAWL_API_KEY = "test-key";
    global.fetch = vi.fn(async () => new Response("", { status: 500, statusText: "Server Error" })) as any;
    await expect(firecrawlSearch("x", 5)).rejects.toThrow(OracleError);
  });
});
