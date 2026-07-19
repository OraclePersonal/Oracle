import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchUrl } from "./fetchUrl.js";
import { OracleError } from "../errors.js";

describe("fetchUrl", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("rejects invalid URLs", async () => {
    await expect(fetchUrl("not a url")).rejects.toThrow(OracleError);
  });

  it("rejects non-http(s) protocols", async () => {
    await expect(fetchUrl("ftp://example.com/file")).rejects.toThrow(OracleError);
  });

  it("strips HTML to readable text and extracts the title", async () => {
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
    expect(page.text).toContain("World  here".replace("  ", " ")); // decoded &nbsp;
    expect(page.text).not.toContain("evil()");
    expect(page.text).not.toContain("<h1>");
  });

  it("returns raw text as-is for non-HTML content types", async () => {
    global.fetch = vi.fn(async () =>
      new Response("plain text body", { status: 200, headers: { "content-type": "text/plain" } })
    ) as any;
    const page = await fetchUrl("https://example.com/robots.txt");
    expect(page.text).toBe("plain text body");
    expect(page.title).toBe("");
  });

  it("throws ORACLE_WEB_UNAVAILABLE on non-ok response", async () => {
    global.fetch = vi.fn(async () => new Response("", { status: 404, statusText: "Not Found" })) as any;
    await expect(fetchUrl("https://example.com/missing")).rejects.toThrow(OracleError);
  });

  it("throws ORACLE_WEB_UNAVAILABLE when the request itself fails", async () => {
    global.fetch = vi.fn(async () => { throw new Error("dns fail"); }) as any;
    await expect(fetchUrl("https://example.com")).rejects.toThrow(OracleError);
  });
});
