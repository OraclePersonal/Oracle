import { describe, it, expect, vi, afterEach } from "vitest";
import { braveSearch } from "./brave.js";
import { OracleError } from "../../errors.js";

describe("braveSearch", () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.BRAVE_API_KEY;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = originalKey;
  });

  it("throws ORACLE_WEB_UNAVAILABLE when BRAVE_API_KEY is unset", async () => {
    delete process.env.BRAVE_API_KEY;
    await expect(braveSearch("test", 5)).rejects.toThrow(OracleError);
  });

  it("returns mapped results on success", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    global.fetch = vi.fn(async (url: any) => {
      expect(String(url)).toContain("api.search.brave.com");
      return new Response(
        JSON.stringify({
          web: {
            results: [
              { title: "Redis Docs", url: "https://redis.io", description: "In-memory store" },
              { title: "Extra", url: "https://example.com", description: "d" },
            ],
          },
        }),
        { status: 200 }
      );
    }) as any;

    const results = await braveSearch("redis", 1);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ title: "Redis Docs", url: "https://redis.io", description: "In-memory store" });
  });

  it("throws ORACLE_WEB_UNAVAILABLE on non-ok response", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    global.fetch = vi.fn(async () => new Response("", { status: 401, statusText: "Unauthorized" })) as any;
    await expect(braveSearch("x", 5)).rejects.toThrow(OracleError);
  });

  it("throws ORACLE_WEB_UNAVAILABLE when the request itself fails", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    global.fetch = vi.fn(async () => { throw new Error("network down"); }) as any;
    await expect(braveSearch("x", 5)).rejects.toThrow(OracleError);
  });
});
