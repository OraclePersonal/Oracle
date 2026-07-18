/**
 * File-system utilities for the Oracle-templates module.
 *
 * All template I/O goes through this module so paths can be mocked in tests.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";

// ── Path helpers ────────────────────────────────────────────────────────────

/** Resolve the user's template directory: <project>/.oracle/templates/ */
export function userTemplateDir(projectRoot?: string): string {
  const root = projectRoot ?? process.cwd();
  return path.join(root, ".oracle", "templates");
}

/** Resolve the built-in template directory (shipped with the package). */
export function builtinTemplateDir(): string {
  // When running from dist/, templates/ is at the package root.
  // During dev (tsx), templates/ is at the project root.
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "..", "templates", "built-in");
}

// ── File helpers ────────────────────────────────────────────────────────────

/**
 * Ensure a directory exists (recursive).
 * No-op if the directory already exists.
 */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Read a JSON file, returning `null` on any error.
 */
export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Write a JSON file with pretty-printing.
 */
export async function writeJson(
  filePath: string,
  data: unknown,
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * List all `.json` files in a directory using fast-glob.
 * Returns an empty array if the directory does not exist.
 */
export async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    await fs.access(dir);
  } catch {
    return [];
  }
  return fg("*.json", { cwd: dir, absolute: true });
}

/**
 * Remove a file, returning silently if it does not exist.
 */
export async function removeFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore ENOENT
  }
}
