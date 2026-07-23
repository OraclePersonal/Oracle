import { AnthropicProvider } from "./anthropic.js";
import { CodexCliProvider, runCommand, type CommandRunner } from "./codex.js";
import { OpenAIProvider, OpenCodeProvider } from "./openai.js";
import type { Provider } from "./provider.js";
import type { AgentProvider } from "../agent/types.js";

export type ProviderName = "codex" | "openai" | "anthropic" | "opencode";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export function parseProviderName(value = "codex"): ProviderName {
  if (value === "codex" || value === "openai" || value === "anthropic" || value === "opencode") return value;
  throw new Error(`Unknown provider: ${value}. Expected codex, openai, anthropic, or opencode.`);
}

export function createProvider(name: ProviderName = "codex"): Provider {
  switch (name) {
    case "anthropic": return new AnthropicProvider();
    case "openai": return new OpenAIProvider();
    case "opencode": return new OpenCodeProvider();
    default: return new CodexCliProvider();
  }
}

/** Providers that implement the agentic tool-use loop (read/write/bash). */
export const AGENT_PROVIDERS: readonly ProviderName[] = ["anthropic", "opencode", "codex"];

/**
 * Create a tool-capable provider for the agentic loop. Supports:
 * - `anthropic` — Anthropic SDK (Claude)
 * - `opencode` — OpenAI-compatible (OpenRouter, Groq, local LLMs) with native function calling
 * - `codex` — Codex CLI via text-based tool calling through `codex exec`
 */
export function createAgentProvider(name: ProviderName): AgentProvider {
  switch (name) {
    case "anthropic": return new AnthropicProvider();
    case "opencode": return new OpenCodeProvider();
    case "codex": return new CodexCliProvider();
    default:
      throw new Error(
        `Provider '${name}' does not support agentic tool use. ` +
          `Set provider to 'anthropic', 'opencode', or 'codex'.`
      );
  }
}

export async function checkProvider(
  name: ProviderName,
  runner: CommandRunner = runCommand
): Promise<DoctorCheck[]> {
  if (name === "openai") {
    return [
      { name: "OPENAI_API_KEY", ok: Boolean(process.env.OPENAI_API_KEY), detail: process.env.OPENAI_API_KEY ? "set" : "not set" },
      { name: "OPENAI_API_BASE", ok: Boolean(process.env.OPENAI_API_BASE), detail: process.env.OPENAI_API_BASE ?? "default (api.openai.com)" },
    ];
  }

  if (name === "anthropic") {
    return [
      { name: "ANTHROPIC_API_KEY", ok: Boolean(process.env.ANTHROPIC_API_KEY), detail: process.env.ANTHROPIC_API_KEY ? "set" : "not set" },
    ];
  }

  if (name === "opencode") {
    return [
      { name: "OPENCODE_API_KEY", ok: Boolean(process.env.OPENCODE_API_KEY ?? process.env.OPENAI_API_KEY), detail: process.env.OPENCODE_API_KEY ? "set (OPENCODE_API_KEY)" : process.env.OPENAI_API_KEY ? "set (OPENAI_API_KEY)" : "not set" },
      { name: "OPENCODE_API_BASE", ok: Boolean(process.env.OPENCODE_API_BASE), detail: process.env.OPENCODE_API_BASE ?? "not set" },
      { name: "OPENCODE_MODEL", ok: Boolean(process.env.OPENCODE_MODEL), detail: process.env.OPENCODE_MODEL ?? "default (gpt-4o)" },
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
