import { describe, expect, test, vi } from "vitest";
import { CodexCliProvider } from "./codex.js";
import { createProvider, checkProvider } from "./factory.js";

describe("provider factory", () => {
  test("creates Codex by default", () => {
    expect(createProvider()).toBeInstanceOf(CodexCliProvider);
  });

  test("reports Codex version and login readiness", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "codex-cli 0.144.4", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "Logged in using ChatGPT", stderr: "" });

    await expect(checkProvider("codex", runner)).resolves.toEqual([
      { name: "codex executable", ok: true, detail: "codex-cli 0.144.4" },
      { name: "codex authentication", ok: true, detail: "Logged in using ChatGPT" }
    ]);
  });
});
