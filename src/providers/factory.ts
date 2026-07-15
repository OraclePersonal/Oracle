import { CodexCliProvider, runCommand, type CommandRunner } from "./codex.js";
import { OpenAIProvider } from "./openai.js";
import type { Provider } from "./provider.js";

export type ProviderName = "codex" | "openai";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export function parseProviderName(value = "codex"): ProviderName {
  if (value === "codex" || value === "openai") return value;
  throw new Error(`Unknown provider: ${value}. Expected codex or openai.`);
}

export function createProvider(name: ProviderName = "codex"): Provider {
  return name === "codex" ? new CodexCliProvider() : new OpenAIProvider();
}

export async function checkProvider(
  name: ProviderName,
  runner: CommandRunner = runCommand
): Promise<DoctorCheck[]> {
  if (name === "openai") {
    return [
      {
        name: "OPENAI_API_KEY",
        ok: Boolean(process.env.OPENAI_API_KEY),
        detail: process.env.OPENAI_API_KEY ? "set" : "not set"
      }
    ];
  }

  try {
    const version = await runner("codex", ["--version"], {});
    if (version.exitCode !== 0) {
      return [{ name: "codex executable", ok: false, detail: version.stderr.trim() }];
    }
    const login = await runner("codex", ["login", "status"], {});
    return [
      { name: "codex executable", ok: true, detail: version.stdout.trim() },
      {
        name: "codex authentication",
        ok: login.exitCode === 0,
        detail: (login.stdout || login.stderr).trim()
      }
    ];
  } catch (error) {
    return [
      {
        name: "codex executable",
        ok: false,
        detail: error instanceof Error ? error.message : String(error)
      }
    ];
  }
}
