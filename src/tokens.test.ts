import { describe, expect, test } from "vitest";
import { estimateTokens } from "./tokens.js";

describe("estimateTokens", () => {
  test("rough estimate based on char count", () => {
    expect(estimateTokens("hello world")).toBe(3);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });
});
