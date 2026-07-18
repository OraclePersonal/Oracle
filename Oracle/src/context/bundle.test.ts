import { describe, expect, test } from "vitest";
import { buildUserPrompt } from "./bundle.js";

describe("buildUserPrompt", () => {
  test("uses a fence longer than backtick runs in file content", () => {
    const result = buildUserPrompt("Review this file", [
      {
        path: "README.md",
        content: "Example:\n```ts\nconst answer = 42;\n```",
        sizeBytes: 43
      }
    ]);

    expect(result).toContain("## README.md\n````\nExample:");
    expect(result).toContain("```\n````");
  });
});
