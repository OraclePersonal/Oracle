import { describe, it, expect, vi, afterEach } from "vitest";
import { tavilySearch } from "./tavily.js";
import { OracleError } from "../../errors.js";

describe("tavilySearch", () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.TAVILY_API_KEY;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = originalKey;
  });

  it("throws ORACLE_WEB_UNAVAILABLE when TAVILY_API_KEY is unset", async () => {
    delete process.env.TAVILY_API_KEY;
    await expect(tavilySearch("test", 5)).rejects.toThrow(OracleError);
  });

  it("returns mapped results on success", async () => {
    process.env.TAVILY_API_KEY = "test-key";
    global.fetch = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain("api.tavily.com/search");
      expect(init.headers.Authorization).toBe("Bearer test-key");
      return new Response(
        JSON.stringify({
          results: [{ title: "Redis Docs", url: "https://redis.io", content: "In-memory store" }],
        }),
        { status: 200 }
      );
    }) as any;

    const results = await tavilySearch("redis", 5);
    expect(results).toEqual([{ title: "Redis Docs", url: "https://redis.io", description: "In-memory store" }]);
  });

  it("throws ORACLE_WEB_UNAVAILABLE on non-ok response", async () => {
    process.env.TAVILY_API_KEY = "test-key";
    global.fetch = vi.fn(async () => new Response("", { status: 401, statusText: "Unauthorized" })) as any;
    await expect(tavilySearch("x", 5)).rejects.toThrow(OracleError);
  });
});
