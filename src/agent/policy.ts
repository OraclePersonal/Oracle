import fs from "node:fs/promises";
import path from "node:path";
import { logSandbox } from "../observability/log.js";

export interface OraclePolicy {
  /** Glob patterns or path substrings forbidden from being read, written, or edited by agents. */
  forbiddenGlobs: string[];
  /** Allowed command prefixes for shell execution (if set, commands must match one prefix). */
  allowedCommands?: string[];
  /** Substrings or patterns strictly forbidden in shell commands. */
  forbiddenCommands: string[];
  /** Maximum file mutations allowed in a single agent session (default: 50). */
  maxMutationsPerSession: number;
}

export const DEFAULT_POLICY: Readonly<OraclePolicy> = Object.freeze({
  forbiddenGlobs: [
    ".env",
    ".env.",
    "id_rsa",
    "id_ed25519",
    ".pem",
    "credentials.json",
    ".oracle/policy.json",
  ],
  forbiddenCommands: [
    "rm -rf /",
    "rm -rf c:",
    "rm -rf c:\\",
    "mkfs",
    "dd if=",
    ":(){ :|:& };:",
  ],
  maxMutationsPerSession: 50,
});

export class PolicyViolationError extends Error {
  constructor(message: string, public readonly rule: string) {
    super(message);
    this.name = "PolicyViolationError";
  }
}

/**
 * Load policy configuration from `.oracle/policy.json` merged with defaults.
 */
export async function loadPolicy(workspaceRoot: string): Promise<OraclePolicy> {
  const policyFile = path.join(workspaceRoot, ".oracle", "policy.json");
  try {
    const raw = JSON.parse(await fs.readFile(policyFile, "utf8")) as Partial<OraclePolicy>;
    return {
      forbiddenGlobs: [...DEFAULT_POLICY.forbiddenGlobs, ...(raw.forbiddenGlobs ?? [])],
      allowedCommands: raw.allowedCommands,
      forbiddenCommands: [...DEFAULT_POLICY.forbiddenCommands, ...(raw.forbiddenCommands ?? [])],
      maxMutationsPerSession: raw.maxMutationsPerSession ?? DEFAULT_POLICY.maxMutationsPerSession,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_POLICY };
    throw new Error(
      `Invalid Oracle policy at ${policyFile}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Validate workspace-relative file path against policy rules.
 */
export function validateFilePath(relPath: string, policy: OraclePolicy): void {
  const normalized = relPath.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/");
  for (const forbidden of policy.forbiddenGlobs) {
    const target = forbidden.toLowerCase();
    const matches =
      normalized === target ||
      normalized.includes(`/${target}`) ||
      normalized.endsWith(target) ||
      (target.endsWith(".") && segments.some((segment) => segment.startsWith(target)));
    if (matches) {
      logSandbox("mutation-denied", { requestedPath: relPath, rule: `forbidden_glob:${forbidden}` });
      throw new PolicyViolationError(`Access to '${relPath}' denied by security policy (forbidden pattern: ${forbidden})`, `forbidden_glob:${forbidden}`);
    }
  }
}

/**
 * Validate shell command string against command policy rules.
 */
export function validateCommand(command: string, policy: OraclePolicy): void {
  const normalized = command.trim().toLowerCase();

  for (const forbidden of policy.forbiddenCommands) {
    if (normalized.includes(forbidden.toLowerCase())) {
      logSandbox("mutation-denied", { command, rule: `forbidden_command:${forbidden}` });
      throw new PolicyViolationError(`Command Execution denied by security policy: forbidden pattern '${forbidden}'`, `forbidden_command:${forbidden}`);
    }
  }

  if (policy.allowedCommands && policy.allowedCommands.length > 0) {
    const allowed = policy.allowedCommands.some((prefix) => normalized.startsWith(prefix.toLowerCase()));
    if (!allowed) {
      logSandbox("mutation-denied", { command, rule: "allowed_commands_mismatch" });
      throw new PolicyViolationError(`Command '${command}' does not match allowed command policy prefixes`, "allowed_commands_mismatch");
    }
  }
}
