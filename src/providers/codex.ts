import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Provider, ProviderRequest } from "./provider.js";
import type { ProviderResponse } from "../types.js";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { input?: string; cwd?: string }
) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.stdin.end(options.input);
  });

export class CodexCliProvider implements Provider {
  readonly id = "codex";
  private readonly runner: CommandRunner;

  constructor(options: { runner?: CommandRunner } = {}) {
    this.runner = options.runner ?? runCommand;
  }

  async run(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.previousResponseId) {
      throw new Error("Codex CLI provider does not support previousResponseId.");
    }

    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mini-oracle-codex-"));
    const outputPath = path.join(temporaryDirectory, "output.md");
    try {
      const result = await this.runner(
        "codex",
        [
          "exec",
          "--sandbox",
          "read-only",
          "--ephemeral",
          "--color",
          "never",
          "--cd",
          request.cwd,
          "--model",
          request.model,
          "--output-last-message",
          outputPath,
          "-"
        ],
        { input: `${request.systemPrompt}\n\n${request.userPrompt}`, cwd: request.cwd }
      );
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `Codex exited with code ${result.exitCode}.`);
      }
      const text = await fs.readFile(outputPath, "utf8");
      if (!text.trim()) throw new Error("Codex returned an empty response.");
      return { text: text.trim(), usage: {} };
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
