import { describe, it, expect, vi, afterEach } from "vitest";
import { agentqlExtract } from "./agentql.js";
import { OracleError } from "../../errors.js";

describe("agentqlExtract", () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.AGENTQL_API_KEY;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.AGENTQL_API_KEY;
    else process.env.AGENTQL_API_KEY = originalKey;
  });

  it("throws ORACLE_WEB_UNAVAILABLE when AGENTQL_API_KEY is unset", async () => {
    delete process.env.AGENTQL_API_KEY;
    await expect(agentqlExtract("https://example.com", "get the price")).rejects.toThrow(OracleError);
  });

  it("returns extracted data with the source URL for citation", async () => {
    process.env.AGENTQL_API_KEY = "test-key";
    global.fetch = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain("api.agentql.com/v1/query-data");
      expect(init.headers["X-API-Key"]).toBe("test-key");
      return new Response(JSON.stringify({ data: { price: "$9.99" } }), { status: 200 });
    }) as any;

    const result = await agentqlExtract("https://example.com", "get the price");
    expect(result).toEqual({ sourceUrl: "https://example.com", prompt: "get the price", data: { price: "$9.99" } });
  });

  it("throws ORACLE_WEB_UNAVAILABLE on non-ok response", async () => {
    process.env.AGENTQL_API_KEY = "test-key";
    global.fetch = vi.fn(async () => new Response("", { status: 401, statusText: "Unauthorized" })) as any;
    await expect(agentqlExtract("https://example.com", "get the price")).rejects.toThrow(OracleError);
  });

  it("rejects an empty object extraction instead of returning it as if valid", async () => {
    process.env.AGENTQL_API_KEY = "test-key";
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })) as any;
    await expect(agentqlExtract("https://example.com", "get the price")).rejects.toThrow(OracleError);
  });

  it("rejects an empty array extraction", async () => {
    process.env.AGENTQL_API_KEY = "test-key";
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as any;
    await expect(agentqlExtract("https://example.com", "get the price")).rejects.toThrow(OracleError);
  });

  it("rejects a null/missing extraction", async () => {
    process.env.AGENTQL_API_KEY = "test-key";
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ data: null }), { status: 200 })) as any;
    await expect(agentqlExtract("https://example.com", "get the price")).rejects.toThrow(OracleError);
  });

  it("accepts a non-empty array extraction", async () => {
    process.env.AGENTQL_API_KEY = "test-key";
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ price: "$9.99" }] }), { status: 200 })) as any;
    const result = await agentqlExtract("https://example.com", "get the price");
    expect(result.data).toEqual([{ price: "$9.99" }]);
  });
});
