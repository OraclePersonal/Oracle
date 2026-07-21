import { readFileSync } from "node:fs";

/**
 * Single source of truth for the CLI/MCP version: read it from package.json
 * at startup rather than hardcoding a string in each entry point (which had
 * drifted — the code said 0.4.0 while package.json said 0.1.0). This file
 * lives one level under the package root in both src/ and dist/, so the
 * relative URL resolves the same before and after compilation.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();
