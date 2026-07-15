import fs from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { CodexCliProvider, type CommandRunner } from "./codex.js";

describe("CodexCliProvider", () => {
  test("runs Codex read-only and ephemeral with the prompt on stdin", async () => {
    const runner: CommandRunner = vi.fn(async (_command, args, options) => {
      const outputPath = args[args.indexOf("--output-last-message") + 1];
      await fs.writeFile(outputPath, "Reviewed successfully", "utf8");
      expect(options.input).toBe("system\n\nuser");
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const provider = new CodexCliProvider({ runner });

    const response = await provider.run({
      model: "gpt-5.4",
      systemPrompt: "system",
      userPrompt: "user",
      cwd: "D:/workspace"
    });

    expect(runner).toHaveBeenCalledWith(
      "codex",
      expect.arrayContaining([
        "exec",
        "--sandbox",
        "read-only",
        "--ephemeral",
        "--cd",
        "D:/workspace",
        "--model",
        "gpt-5.4",
        "-"
      ]),
      expect.objectContaining({ input: "system\n\nuser" })
    );
    expect(response).toEqual({ text: "Reviewed successfully", usage: {} });
  });

  test("rejects Responses API follow-up ids", async () => {
    const provider = new CodexCliProvider({ runner: vi.fn() });
    await expect(
      provider.run({
        model: "gpt-5.4",
        systemPrompt: "system",
        userPrompt: "user",
        cwd: "D:/workspace",
        previousResponseId: "response-id"
      })
    ).rejects.toThrow("does not support previousResponseId");
  });
});
