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

  it("returns extracted data on success", async () => {
    process.env.AGENTQL_API_KEY = "test-key";
    global.fetch = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain("api.agentql.com/v1/query-data");
      expect(init.headers["X-API-Key"]).toBe("test-key");
      return new Response(JSON.stringify({ data: { price: "$9.99" } }), { status: 200 });
    }) as any;

    const data = await agentqlExtract("https://example.com", "get the price");
    expect(data).toEqual({ price: "$9.99" });
  });

  it("throws ORACLE_WEB_UNAVAILABLE on non-ok response", async () => {
    process.env.AGENTQL_API_KEY = "test-key";
    global.fetch = vi.fn(async () => new Response("", { status: 401, statusText: "Unauthorized" })) as any;
    await expect(agentqlExtract("https://example.com", "get the price")).rejects.toThrow(OracleError);
  });
});
