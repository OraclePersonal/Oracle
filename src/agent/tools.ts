import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { exec } from "node:child_process";
import type { AgentContext, AgentTool, ContentBlock } from "./types.js";
import { logSandbox } from "../observability/log.js";

/** Cap on how much text any single tool returns to the model. */
const MAX_OUTPUT_CHARS = 30_000;

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
    logSandbox("path-escape", { requestedPath: rel, resolvedPath: abs, workspaceRoot: root });
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
 * The default toolset: read, write, edit, list, glob, grep, media reads,
 * and shell execution. File tools resolve paths through resolveInWorkspace
 * so the agent can only ever touch files inside the workspace root.
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
        const rel = str(input, "path");
        const abs = resolveInWorkspace(ctx, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        const content = str(input, "content");
        await fs.writeFile(abs, content, "utf8");
        if (ctx.audit) {
          const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);
          ctx.audit.record("write", rel, { sizeBytes: content.length, contentHash: hash });
        }
        return `Wrote ${content.length} chars to ${rel}`;
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
        const newContent = content.replace(oldStr, newStr);
        await fs.writeFile(abs, newContent, "utf8");
        if (ctx.audit) {
          const hash = createHash("sha256").update(newContent).digest("hex").slice(0, 8);
          ctx.audit.record("edit", rel, { sizeBytes: newContent.length, contentHash: hash });
        }
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
      name: "read_image",
      description: "Read an image file and return it as base64 for the model to see. Supports PNG, JPEG, GIF, WebP.",
      mutating: false,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Image file path (relative to workspace)" },
        },
        required: ["path"],
      },
      async execute(input, ctx) {
        const filePath = resolveInWorkspace(ctx, str(input, "path"));
        const data = await fs.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
        }[ext];
        if (!mimeType) throw new ToolError(`Unsupported image format: ${ext}`);
        const contentBlock: ContentBlock = {
          type: "image",
          mimeType,
          data: data.toString("base64"),
        };
        return [contentBlock];
      },
    },
    {
      name: "read_video",
      description: "Read a video file and return it as base64 for the model to see. Supports MP4, WebM.",
      mutating: false,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Video file path (relative to workspace)" },
        },
        required: ["path"],
      },
      async execute(input, ctx) {
        const filePath = resolveInWorkspace(ctx, str(input, "path"));
        const data = await fs.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = {
          ".mp4": "video/mp4",
          ".webm": "video/webm",
          ".mkv": "video/x-matroska",
        }[ext];
        if (!mimeType) throw new ToolError(`Unsupported video format: ${ext}`);
        const contentBlock: ContentBlock = {
          type: "video",
          mimeType,
          data: data.toString("base64"),
        };
        return [contentBlock];
      },
    },
    {
      name: "bash",
      description:
        "Run a shell command in the workspace root directory. Use for running tests, git operations, build tools, linters, etc. Commands timeout after 60 seconds (configurable via the timeout param in ms).",
      mutating: true,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          timeout: {
            type: "number",
            description: "Timeout in milliseconds (default: 60000, max: 300000)",
          },
        },
        required: ["command"],
      },
      async execute(input, ctx) {
        assertWritable(ctx, "bash");
        const command = str(input, "command");
        const timeout = Math.min(Math.max(Number(input.timeout) || 60000, 1000), 300000);
        const shell = process.env.SHELL || undefined; // respect user's shell when set
        const stdout = await new Promise<string>((resolve, reject) => {
          exec(command, { cwd: ctx.workspaceRoot, timeout, maxBuffer: 10 * 1024 * 1024, shell }, (err, out, stderr) => {
            let output = out || "";
            if (stderr) {
              if (output) output += "\n";
              output += stderr;
            }
            if (err) {
              if (err.killed) reject(new ToolError(`Command timed out after ${timeout}ms`));
              else reject(new ToolError(output || err.message));
            } else {
              resolve(output || "(no output)");
            }
          });
        });
        if (ctx.audit) {
          ctx.audit.record("bash", command.slice(0, 200), { timeout });
        }
        return truncate(stdout);
      },
    },
  ];
}
