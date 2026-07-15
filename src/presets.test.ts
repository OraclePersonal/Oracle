import { describe, expect, test } from "vitest";
import { composePresetSystemPrompt, PRESET_NAMES } from "./presets.js";

describe("presets", () => {
  test("exposes the supported preset names", () => {
    expect(PRESET_NAMES).toEqual(["review", "debug", "architecture", "tests", "security"]);
  });

  test.each(PRESET_NAMES)("composes %s with the base system prompt", (preset) => {
    const result = composePresetSystemPrompt(preset, "Base prompt");
    expect(result).toContain("Base prompt");
    expect(result.length).toBeGreaterThan("Base prompt".length);
  });
});
