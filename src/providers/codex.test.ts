import fs from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import {
  CodexCliProvider,
  resolveCommandInvocation,
  type CommandRunner
} from "./codex.js";

describe("resolveCommandInvocation", () => {
  test("runs the Codex JavaScript entrypoint directly on Windows", () => {
    expect(
      resolveCommandInvocation("codex", ["--version"], {
        platform: "win32",
        execPath: "C:/Program Files/nodejs/node.exe",
        appData: "C:/Users/Test/AppData/Roaming"
      })
    ).toEqual({
      command: "C:/Program Files/nodejs/node.exe",
      args: ["C:/Users/Test/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js", "--version"]
    });
  });

  test("keeps the command unchanged outside Windows", () => {
    expect(
      resolveCommandInvocation("codex", ["--version"], {
        platform: "linux",
        execPath: "/usr/bin/node"
      })
    ).toEqual({ command: "codex", args: ["--version"] });
  });
});

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

  test("tolerates previousResponseId (ignored, re-runs fresh)", async () => {
    const runner: CommandRunner = vi.fn(async (_command, args) => {
      const outputPath = args[args.indexOf("--output-last-message") + 1];
      await fs.writeFile(outputPath, "Fresh review", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const provider = new CodexCliProvider({ runner });

    const response = await provider.run({
      model: "gpt-5.4",
      systemPrompt: "system",
      userPrompt: "user",
      cwd: "D:/workspace",
      previousResponseId: "response-id"
    });

    expect(response.text).toBe("Fresh review");
  });
});
