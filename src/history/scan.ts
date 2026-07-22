import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import fg from "fast-glob";

/**
 * Cross-tool session-history recall: discover the conversation logs that AI
 * CLI tools keep under the user's home dir (~/.claude, ~/.codex, ~/.gemini,
 * ~/.opencode, …) and search them time-first.
 *
 * Nothing is hardcoded per tool. Discovery = every top-level dot-directory
 * probed against a small set of LAYOUT PATTERNS (where tools of this kind
 * keep chat logs), then each candidate file is sniffed: it only counts if
 * its first lines actually parse as chat-ish JSON (a role/message/timestamp
 * shape). A brand-new tool that follows any of these conventions is picked
 * up automatically; one that doesn't can be added via ORACLE_HISTORY_DIRS
 * (path-separator-joined list of extra roots to probe).
 */

export interface HistorySource {
  tool: string;      // dot-dir name without the dot, e.g. "claude"
  root: string;      // absolute dir the files live under
  files: string[];   // absolute jsonl/json files, newest mtime first
}

export interface HistoryEntry {
  ts: string | null; // ISO timestamp if the entry had one
  role: string;      // user | assistant | ...
  text: string;
  tool: string;
  file: string;
}

/** Where tools of this kind conventionally keep chat logs, relative to their dot-dir. */
const LAYOUT_PATTERNS = [
  "projects/**/*.jsonl",   // Claude Code
  "sessions/**/*.jsonl",   // Codex CLI and friends
  "**/history.jsonl",      // Gemini/antigravity style
  "chats/**/*.json*",
  "storage/session/**/*.json*" // opencode style
];

/** Junk that lives inside tool dirs but is never a conversation log. */
const IGNORE = [
  "**/node_modules/**", "**/.git/**", "**/.tmp/**", "**/tmp/**", "**/cache/**",
  "**/backups/**", "**/fixtures/**", "**/logs/**", "**/extensions/**",
  "**/plugins/**", "**/packages/**", "**/bin/**", "**/dist/**"
];

const MAX_FILES_PER_TOOL = 100;    // newest N files considered per tool
const MAX_FILE_BYTES = 10_000_000; // skip enormous transcripts
const READ_TAIL_BYTES = 2_000_000; // jsonl appends → newest entries live at the end
const SNIFF_LINES = 8;             // how many lines to check when sniffing
const GLOB_DEPTH = 5;

function looksLikeChat(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  const msg = o.message as Record<string, unknown> | undefined;
  return (
    typeof msg?.role === "string" ||
    typeof o.role === "string" ||
    o.type === "user" ||
    o.type === "assistant" ||
    (typeof o.timestamp === "string" && ("content" in o || "text" in o))
  );
}

async function sniffFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (stat.size === 0 || stat.size > MAX_FILE_BYTES) return false;
    const fh = await fs.open(file, "r");
    try {
      const { buffer, bytesRead } = await fh.read(Buffer.alloc(16384), 0, 16384, 0);
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n").slice(0, SNIFF_LINES);
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try { if (looksLikeChat(JSON.parse(t))) return true; } catch { /* partial/non-JSON line */ }
      }
      return false;
    } finally { await fh.close(); }
  } catch { return false; }
}

/** Scan home for dot-dirs, probe layout patterns, sniff candidates. */
export async function discoverSources(home: string = os.homedir()): Promise<HistorySource[]> {
  let names: string[] = [];
  try { names = await fs.readdir(home); } catch { return []; }
  const roots = names.filter((n) => n.startsWith(".") && n.length > 1).map((n) => path.join(home, n));
  for (const extra of (process.env.ORACLE_HISTORY_DIRS ?? "").split(path.delimiter).filter(Boolean)) {
    roots.push(extra);
  }

  const sources: HistorySource[] = [];
  for (const root of roots) {
    try {
      if (!(await fs.stat(root)).isDirectory()) continue;
    } catch { continue; }
    const found = await fg(LAYOUT_PATTERNS, {
      cwd: root, ignore: IGNORE, absolute: true, onlyFiles: true,
      deep: GLOB_DEPTH, suppressErrors: true, dot: false
    });
    if (found.length === 0) continue;

    // newest first, capped, then sniff — mtime order means the cap keeps recent sessions
    const withTimes = await Promise.all(found.map(async (f) => {
      try { return { f, mtime: (await fs.stat(f)).mtimeMs }; } catch { return null; }
    }));
    const candidates = withTimes
      .filter((x): x is { f: string; mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_FILES_PER_TOOL);

    const files: string[] = [];
    for (const { f } of candidates) if (await sniffFile(f)) files.push(f);
    if (files.length) {
      sources.push({ tool: path.basename(root).replace(/^\./, ""), root, files });
    }
  }
  return sources;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : typeof (b as { text?: string })?.text === "string" ? (b as { text: string }).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function toEntry(obj: Record<string, unknown>, tool: string, file: string): HistoryEntry | null {
  const msg = obj.message as Record<string, unknown> | undefined;
  const role = (msg?.role ?? obj.role ?? (obj.type === "user" || obj.type === "assistant" ? obj.type : null)) as string | null;
  if (role !== "user" && role !== "assistant") return null; // conversation turns only
  const text = extractText(msg?.content ?? obj.content ?? obj.text);
  if (!text.trim()) return null;
  const ts = (obj.timestamp ?? obj.ts ?? obj.created_at ?? obj.time ?? null) as string | null;
  return { ts, role, text, tool, file };
}

/**
 * Time-first search over discovered histories. `since`/`until` bound entry
 * timestamps (files are pre-filtered by mtime for speed); `query` is a
 * case-insensitive substring; `tool` narrows to one source (e.g. "claude").
 */
export async function searchHistory(opts: {
  since?: string;
  until?: string;
  query?: string;
  tool?: string;
  limit?: number;
  home?: string;
}): Promise<HistoryEntry[]> {
  const limit = opts.limit ?? 20;
  const q = opts.query?.toLowerCase();
  const sinceMs = opts.since ? Date.parse(opts.since) : null;
  const sources = (await discoverSources(opts.home)).filter((s) => !opts.tool || s.tool === opts.tool);

  const hits: HistoryEntry[] = [];
  for (const src of sources) {
    for (const file of src.files) {
      // enough material collected — stop opening more files (they're mtime-ordered,
      // so what remains is older anyway)
      if (hits.length >= limit * 5) break;
      try {
        const stat = await fs.stat(file);
        // a file whose last write predates `since` cannot contain newer entries
        if (sinceMs !== null && stat.mtimeMs < sinceMs) continue;
        // jsonl is append-only: the tail holds the newest entries, so a bounded
        // tail read keeps huge transcripts cheap without losing recency
        let raw: string;
        if (stat.size > READ_TAIL_BYTES) {
          const fh = await fs.open(file, "r");
          try {
            const start = stat.size - READ_TAIL_BYTES;
            const { buffer, bytesRead } = await fh.read(Buffer.alloc(READ_TAIL_BYTES), 0, READ_TAIL_BYTES, start);
            raw = buffer.subarray(0, bytesRead).toString("utf8");
            raw = raw.slice(raw.indexOf("\n") + 1); // drop the torn first line
          } finally { await fh.close(); }
        } else {
          raw = await fs.readFile(file, "utf8");
        }
        for (const line of raw.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          let obj: unknown;
          try { obj = JSON.parse(t); } catch { continue; }
          const entry = toEntry(obj as Record<string, unknown>, src.tool, file);
          if (!entry) continue;
          if (opts.since && entry.ts && entry.ts < opts.since) continue;
          if (opts.until && entry.ts && entry.ts > opts.until) continue;
          if (q && !entry.text.toLowerCase().includes(q)) continue;
          hits.push(entry);
        }
      } catch { /* unreadable file — skip */ }
    }
  }
  return hits
    .sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""))
    .slice(0, limit);
}
