import { describe, it, expect } from "vitest";
import { createSkillTemplate } from "./skill.js";

describe("createSkillTemplate", () => {
  it("returns a valid skill template", () => {
    const result = createSkillTemplate({
      name: "code-review",
      description: "Review code changes for bugs",
      author: "test",
      tags: ["review"],
    });

    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.name).toBe("skill-code-review");
    expect(result.data!.type).toBe("skill");
    expect(result.data!.files).toHaveLength(1);
    expect(result.data!.files![0].path).toBe("code-review.md");
    expect(result.data!.tags).toContain("skill");
    expect(result.data!.tags).toContain("review");
  });

  it("fails when name is empty", () => {
    const result = createSkillTemplate({
      name: "",
      description: "x",
    });
    expect(result.ok).toBe(false);
  });
});
