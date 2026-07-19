import { describe, it, expect, vi, afterEach } from "vitest";
import { webSearch } from "./search.js";
import { OracleError } from "../errors.js";

describe("webSearch dispatch", () => {
  const originalFetch = global.fetch;
  const keys = ["BRAVE_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY"] as const;
  const originalEnv = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

  afterEach(() => {
    global.fetch = originalFetch;
    for (const k of keys) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("throws when no provider has a configured key", async () => {
    for (const k of keys) delete process.env[k];
    await expect(webSearch("test")).rejects.toThrow(OracleError);
  });

  it("auto-selects brave first when multiple keys are configured", async () => {
    process.env.BRAVE_API_KEY = "b";
    process.env.TAVILY_API_KEY = "t";
    global.fetch = vi.fn(async (url: any) => {
      expect(String(url)).toContain("api.search.brave.com");
      return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
    }) as any;
    await webSearch("test");
    expect(global.fetch).toHaveBeenCalled();
  });

  it("falls back to tavily when only TAVILY_API_KEY is set", async () => {
    for (const k of keys) delete process.env[k];
    process.env.TAVILY_API_KEY = "t";
    global.fetch = vi.fn(async (url: any) => {
      expect(String(url)).toContain("api.tavily.com");
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as any;
    await webSearch("test");
    expect(global.fetch).toHaveBeenCalled();
  });

  it("respects an explicit provider override even if a higher-priority key is set", async () => {
    process.env.BRAVE_API_KEY = "b";
    process.env.TAVILY_API_KEY = "t";
    global.fetch = vi.fn(async (url: any) => {
      expect(String(url)).toContain("api.tavily.com");
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as any;
    await webSearch("test", 5, "tavily");
    expect(global.fetch).toHaveBeenCalled();
  });
});
