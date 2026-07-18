import { describe, expect, test } from "vitest";
import { SkillRegistry } from "./skills/registry.js";
import { DEFAULT_SYSTEM_PROMPT } from "./context/bundle.js";

describe("skills", () => {
  test("loads built-in skills", async () => {
    const registry = new SkillRegistry("/tmp");
    await registry.load();
    const names = registry.names();
    expect(names).toContain("review");
    expect(names).toContain("debug");
    expect(names).toContain("architecture");
    expect(names).toContain("tests");
    expect(names).toContain("security");
  });

  test("composes skill with base prompt", async () => {
    const registry = new SkillRegistry("/tmp");
    await registry.load();
    const result = registry.compose("review", DEFAULT_SYSTEM_PROMPT);
    expect(result).toContain(DEFAULT_SYSTEM_PROMPT);
    expect(result.length).toBeGreaterThan(DEFAULT_SYSTEM_PROMPT.length);
  });
});
