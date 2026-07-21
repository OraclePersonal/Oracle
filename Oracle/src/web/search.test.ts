import { describe, it, expect, vi, afterEach } from "vitest";
import { webSearch, webSearchWithTrace } from "./search.js";
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

  it("auto-selects brave first when multiple keys are configured, tagged auto-detected", async () => {
    process.env.BRAVE_API_KEY = "b";
    process.env.TAVILY_API_KEY = "t";
    global.fetch = vi.fn(async (url: any) => {
      expect(String(url)).toContain("api.search.brave.com");
      return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
    }) as any;
    const outcome = await webSearchWithTrace("test");
    expect(outcome.provider).toBe("brave");
    expect(outcome.attempts).toEqual([{ provider: "brave", reason: "auto-detected", outcome: "success", latencyMs: expect.any(Number) }]);
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
    const outcome = await webSearchWithTrace("test", 5, "tavily");
    expect(outcome.attempts[0].reason).toBe("explicit");
  });

  it("falls through to the next configured provider when the first is unavailable, and records both attempts", async () => {
    process.env.BRAVE_API_KEY = "b";
    process.env.TAVILY_API_KEY = "t";
    let call = 0;
    global.fetch = vi.fn(async (url: any) => {
      call++;
      if (String(url).includes("brave")) return new Response("", { status: 500, statusText: "Server Error" });
      return new Response(JSON.stringify({ results: [{ title: "T", url: "https://x.com", content: "d" }] }), { status: 200 });
    }) as any;

    const outcome = await webSearchWithTrace("test");
    expect(call).toBe(2);
    expect(outcome.provider).toBe("tavily");
    expect(outcome.attempts.map((a) => [a.provider, a.reason, a.outcome])).toEqual([
      ["brave", "auto-detected", "failure"],
      ["tavily", "fallback", "success"],
    ]);
  });

  it("throws mentioning every provider's error when all configured providers fail", async () => {
    process.env.BRAVE_API_KEY = "b";
    process.env.TAVILY_API_KEY = "t";
    global.fetch = vi.fn(async () => new Response("", { status: 500, statusText: "Server Error" })) as any;
    await expect(webSearchWithTrace("test")).rejects.toThrow(/brave/);
    await expect(webSearchWithTrace("test")).rejects.toThrow(/tavily/);
  });
});
