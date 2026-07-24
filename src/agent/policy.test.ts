import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, validateCommand, validateFilePath, PolicyViolationError } from "./policy.js";

describe("OraclePolicy Enforcement", () => {
  it("allows standard workspace relative paths", () => {
    expect(() => validateFilePath("src/index.ts", DEFAULT_POLICY)).not.toThrow();
    expect(() => validateFilePath("README.md", DEFAULT_POLICY)).not.toThrow();
  });

  it("blocks forbidden globs and sensitive files", () => {
    expect(() => validateFilePath(".env", DEFAULT_POLICY)).toThrow(PolicyViolationError);
    expect(() => validateFilePath("config/.env.local", DEFAULT_POLICY)).toThrow(PolicyViolationError);
    expect(() => validateFilePath("keys/id_rsa", DEFAULT_POLICY)).toThrow(PolicyViolationError);
    expect(() => validateFilePath("server.pem", DEFAULT_POLICY)).toThrow(PolicyViolationError);
  });

  it("validates command execution blacklists", () => {
    expect(() => validateCommand("npm test", DEFAULT_POLICY)).not.toThrow();
    expect(() => validateCommand("rm -rf /", DEFAULT_POLICY)).toThrow(PolicyViolationError);
    expect(() => validateCommand("dd if=/dev/zero", DEFAULT_POLICY)).toThrow(PolicyViolationError);
  });

  it("enforces allowed command prefixes when set", () => {
    const strictPolicy = {
      ...DEFAULT_POLICY,
      allowedCommands: ["npm", "git", "node"],
    };

    expect(() => validateCommand("npm test", strictPolicy)).not.toThrow();
    expect(() => validateCommand("git status", strictPolicy)).not.toThrow();
    expect(() => validateCommand("curl https://malicious.site", strictPolicy)).toThrow(PolicyViolationError);
  });
});
