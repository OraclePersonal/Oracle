import { describe, it, expect } from "vitest";
import { TemplateSchema, TEMPLATE_TYPES } from "./types.js";

describe("TemplateSchema", () => {
  it("validates a minimal skill template", () => {
    const result = TemplateSchema.safeParse({
      name: "test-skill",
      type: "skill",
      description: "A test skill",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a template without a name", () => {
    const result = TemplateSchema.safeParse({
      type: "skill",
      description: "no name",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid type", () => {
    const result = TemplateSchema.safeParse({
      name: "bad",
      type: "invalid",
      description: "x",
    });
    expect(result.success).toBe(false);
  });

  it("applies defaults for optional fields", () => {
    const result = TemplateSchema.parse({
      name: "tpl",
      type: "session",
      description: "x",
    });
    expect(result.version).toBe("1.0.0");
    expect(result.tags).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.metadata).toEqual({});
  });
});

describe("TEMPLATE_TYPES", () => {
  it("contains skill, oracle, session", () => {
    expect(TEMPLATE_TYPES).toEqual(["skill", "oracle", "session"]);
  });
});
