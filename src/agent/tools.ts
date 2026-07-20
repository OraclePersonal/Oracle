import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentContext, AgentTool } from "./types.js";

/** Cap on how much text any single tool returns to the model. */
const MAX_OUTPUT_CHARS = 30_000;
/** Default bash timeout (ms). */
const BASH_TIMEOUT_MS = 120_000;

class ToolError extends Error {}

/**
 * Resolve a caller-supplied path against the workspace root and refuse
 * anything that escapes it. This is the single trust boundary for every
 * filesystem tool — no tool should touch a path it did not get from here.
 */
function resolveInWorkspace(ctx: AgentContext, rel: string): string {
  const abs = path.resolve(ctx.workspaceRoot, rel);
  const root = path.resolve(ctx.workspaceRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new ToolError(`Path escapes the workspace: ${rel}`);
  }
  return abs;
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[... truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
}

function assertWritable(ctx: AgentContext, tool: string): void {
  if (ctx.readOnly) {
    throw new ToolError(`${tool} is disabled in read-only mode.`);
  }
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string") throw new ToolError(`'${key}' must be a string.`);
  return v;
}

function optStr(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ToolError(`'${key}' must be a string.`);
  return v;
}

async function runBash(command: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`Failed to start command: ${err.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const parts = [
        stdout && `[stdout]\n${stdout}`,
        stderr && `[stderr]\n${stderr}`,
        killed ? `[killed after ${timeoutMs}ms timeout]` : `[exit ${code ?? 0}]`,
      ].filter(Boolean);
      resolve(parts.join("\n\n") || `[exit ${code ?? 0}]`);
    });
  });
}

/** Recursively walk a directory, returning workspace-relative file paths. */
async function walk(dir: string, root: string, acc: string[], limit: number): Promise<void> {
  if (acc.length >= limit) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (acc.length >= limit) return;
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(abs, root, acc, limit);
    } else if (entry.isFile()) {
      acc.push(path.relative(root, abs));
    }
  }
}

/**
 * The default Claude-Code-style toolset: read, write, edit, list, glob,
 * grep, and bash. All filesystem access is confined to the workspace root.
 */
export function defaultAgentTools(): AgentTool[] {
  return [
    {
      name: "read_file",
      description: "Read a UTF-8 text file from the workspace. Returns its full contents (truncated if very large).",
      mutating: false,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative file path" } },
        required: ["path"],
      },
      async execute(input, ctx) {
        const abs = resolveInWorkspace(ctx, str(input, "path"));
        const content = await fs.readFile(abs, "utf8");
        return truncate(content);
      },
    },
    {
      name: "write_file",
      description: "Create or overwrite a file with the given content. Creates parent directories as needed.",
      mutating: true,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path" },
          content: { type: "string", description: "Full file content to write" },
        },
        required: ["path", "content"],
      },
      async execute(input, ctx) {
        assertWritable(ctx, "write_file");
        const abs = resolveInWorkspace(ctx, str(input, "path"));
        await fs.mkdir(path.dirname(abs), { recursive: true });
        const content = str(input, "content");
        await fs.writeFile(abs, content, "utf8");
        return `Wrote ${content.length} chars to ${str(input, "path")}`;
      },
    },
    {
      name: "edit_file",
      description: "Replace an exact string in a file with a new string. The old string must appear exactly once. Use for targeted edits.",
      mutating: true,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path" },
          old_string: { type: "string", description: "Exact text to replace (must be unique in the file)" },
          new_string: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_string", "new_string"],
      },
      async execute(input, ctx) {
        assertWritable(ctx, "edit_file");
        const rel = str(input, "path");
        const abs = resolveInWorkspace(ctx, rel);
        const oldStr = str(input, "old_string");
        const newStr = str(input, "new_string");
        const content = await fs.readFile(abs, "utf8");
        const occurrences = content.split(oldStr).length - 1;
        if (occurrences === 0) throw new ToolError(`old_string not found in ${rel}`);
        if (occurrences > 1) throw new ToolError(`old_string appears ${occurrences} times in ${rel}; make it unique.`);
        await fs.writeFile(abs, content.replace(oldStr, newStr), "utf8");
        return `Edited ${rel}`;
      },
    },
    {
      name: "list_dir",
      description: "List immediate entries (files and folders) of a workspace directory.",
      mutating: false,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative directory (default: root)" } },
      },
      async execute(input, ctx) {
        const rel = optStr(input, "path") ?? ".";
        const abs = resolveInWorkspace(ctx, rel);
        const entries = await fs.readdir(abs, { withFileTypes: true });
        const lines = entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort();
        return lines.join("\n") || "(empty)";
      },
    },
    {
      name: "glob",
      description: "Find files whose workspace-relative path contains the given substring (skips node_modules, .git, dist).",
      mutating: false,
      inputSchema: {
        type: "object",
        properties: { pattern: { type: "string", description: "Substring to match in file paths, e.g. '.test.ts'" } },
        required: ["pattern"],
      },
      async execute(input, ctx) {
        const pattern = str(input, "pattern");
        const acc: string[] = [];
        await walk(ctx.workspaceRoot, ctx.workspaceRoot, acc, 5000);
        const matches = acc.filter((p) => p.includes(pattern)).sort();
        return truncate(matches.join("\n") || "(no matches)");
      },
    },
    {
      name: "grep",
      description: "Search file contents for a substring across the workspace. Returns matching lines with file path and line number.",
      mutating: false,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring to search for" },
          path_filter: { type: "string", description: "Optional: only search files whose path contains this substring" },
        },
        required: ["query"],
      },
      async execute(input, ctx) {
        const query = str(input, "query");
        const pathFilter = optStr(input, "path_filter");
        const files: string[] = [];
        await walk(ctx.workspaceRoot, ctx.workspaceRoot, files, 5000);
        const hits: string[] = [];
        for (const rel of files) {
          if (pathFilter && !rel.includes(pathFilter)) continue;
          if (hits.length >= 200) break;
          let content: string;
          try {
            content = await fs.readFile(path.join(ctx.workspaceRoot, rel), "utf8");
          } catch {
            continue;
          }
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(query)) {
              hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
              if (hits.length >= 200) break;
            }
          }
        }
        return truncate(hits.join("\n") || "(no matches)");
      },
    },
    {
      name: "bash",
      description: "Run a shell command in the workspace root and return its combined output. Use for builds, tests, git, etc.",
      mutating: true,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          timeout_ms: { type: "number", description: `Timeout in ms (default ${BASH_TIMEOUT_MS})` },
        },
        required: ["command"],
      },
      async execute(input, ctx) {
        assertWritable(ctx, "bash");
        const command = str(input, "command");
        const timeout = typeof input.timeout_ms === "number" ? input.timeout_ms : BASH_TIMEOUT_MS;
        const out = await runBash(command, ctx.workspaceRoot, timeout);
        return truncate(out);
      },
    },
  ];
}
