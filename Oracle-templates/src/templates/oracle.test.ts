import { describe, it, expect } from "vitest";
import { createOracleTemplate } from "./oracle.js";

describe("createOracleTemplate", () => {
  it("returns a valid oracle template", () => {
    const result = createOracleTemplate({
      name: "my-agent",
      description: "A custom oracle agent",
      author: "test",
      model: "opus",
    });

    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.name).toBe("oracle-my-agent");
    expect(result.data!.type).toBe("oracle");
    expect(result.data!.metadata!.defaultModel).toBe("opus");
    expect(result.data!.files).toHaveLength(1);
    expect(result.data!.files![0].path).toBe("my-agent.oracle.json");
  });

  it("fails when name is empty", () => {
    const result = createOracleTemplate({
      name: "",
      description: "x",
    });
    expect(result.ok).toBe(false);
  });
});
