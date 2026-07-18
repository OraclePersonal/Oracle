import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { OracleError } from "../errors.js";
import type { ProviderName } from "../providers/factory.js";

export interface ProjectConfig {
  provider: ProviderName;
  model: string;
  include: string[];
  exclude: string[];
  maxFileSizeBytes: number;
  maxInputBytes: number;
}

const schema = z
  .object({
    provider: z.enum(["codex", "openai", "anthropic"]).optional(),
    model: z.string().trim().min(1).optional(),
    include: z.array(z.string().trim().min(1)).min(1).optional(),
    exclude: z.array(z.string().trim().min(1)).optional(),
    maxFileSizeBytes: z.number().int().positive().optional(),
    maxInputBytes: z.number().int().positive().optional()
  })
  .strict();

export const DEFAULT_PROJECT_CONFIG: Readonly<ProjectConfig> = Object.freeze({
  provider: "codex",
  model: "gpt-5.4",
  include: Object.freeze(["src/**/*", "README.md", "package.json"]) as unknown as string[],
  exclude: Object.freeze([
    "**/*.test.ts",
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**"
  ]) as unknown as string[],
  maxFileSizeBytes: 1_000_000,
  maxInputBytes: 5_000_000
});

function copyDefaults(): ProjectConfig {
  return {
    ...DEFAULT_PROJECT_CONFIG,
    include: [...DEFAULT_PROJECT_CONFIG.include],
    exclude: [...DEFAULT_PROJECT_CONFIG.exclude]
  };
}

export async function loadProjectConfig(root: string): Promise<ProjectConfig> {
  const configPath = path.join(path.resolve(root), ".oracle", "config.json");
  try {
    const raw = JSON.parse(await fs.readFile(configPath, "utf8")) as unknown;
    const parsed = schema.parse(raw);
    return { ...copyDefaults(), ...parsed };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return copyDefaults();
    throw new OracleError(
      "ORACLE_CONFIG_INVALID",
      "The project Oracle configuration is invalid.",
      "Fix .oracle/config.json or remove it to use defaults.",
      { configPath, reason: error instanceof Error ? error.message : String(error) }
    );
  }
}
