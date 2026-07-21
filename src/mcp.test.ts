import fs from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("MCP consult boundary", () => {
  test("does not let tool callers replace the server working directory", async () => {
    const source = await fs.readFile(new URL("./mcp.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/^\s*cwd:\s*z\.string\(\)\.optional\(\),?$/m);
  });
});
